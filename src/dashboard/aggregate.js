"use strict";
const fs = require("fs");
const path = require("path");
const { translateRoom } = require("../roomsSidecar");
const { extractAcceptanceLinks } = require("../links");
const { formatTaskNumber } = require("../taskNumber");
const { findApproval } = require("../approvalStore");

// judging/judged 為 LLM 判斷紀錄(見 judgeStatus.js):judging=判斷中,judged=判定不觸發/判斷失敗。
// 一併列進任務清單,使用者才分得清「沒收到 vs 判斷中 vs LLM 拒絕 vs 判斷失敗」。
const STATUS_DIRS = ["judging", "judged", "pending", "processing", "done", "failed", "blocked", "review"];

// 合併四個狀態目錄的任務檔,翻譯房間名稱,依 enqueued_at 新到舊排序,取前 limit 筆。
// 壞掉的 JSON 不讓整批失敗,標記 parseError 後保留。
function collectTasks(queueDir, roomsMap, limit) {
  const out = [];
  for (const status of STATUS_DIRS) {
    let files;
    try {
      files = fs.readdirSync(path.join(queueDir, status));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      // 只取任務檔;failed/ 內的 <id>.json.error.txt 旁檔不以 .json 結尾,自動排除。
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      let task;
      try {
        task = JSON.parse(fs.readFileSync(path.join(queueDir, status, f), "utf8"));
      } catch (_) {
        out.push({ id, task_number: formatTaskNumber(id), status, parseError: true });
        continue;
      }
      const src = task.source || {};
      let approval = null;
      try { approval = findApproval(queueDir, id); }
      catch (error) {
        approval = { status: "failed", event: { task_id: id, last_error: String((error && error.message) || error) } };
      }
      out.push({
        id,
        task_number: formatTaskNumber(id),
        status,
        rule: task.rule,
        task: task.task,
        room_id: src.room_id,
        room_name: translateRoom(src.room_id, roomsMap),
        sender: src.sender,
        body: src.body,
        event_id: src.event_id,
        enqueued_at: task.enqueued_at,
        verified: isVerified(queueDir, id) || !!(approval && approval.status === "done"),
        ...(approval ? { approval: { status: approval.status, ...approval.event } } : {}),
        ...(task.judge ? { judge: task.judge } : {}),
        // skill-dispatch(通用「計程車」任務)專用:任務清單只顯示得到 task === "skill-dispatch",
        // 分不出送去哪個專案、送了什麼指令,故把規則存進 task 的這兩欄一併帶出供 dashboard 顯示。
        ...(task.project_path ? { project_path: task.project_path } : {}),
        ...(task.target_branch ? { target_branch: task.target_branch } : {}),
        ...(task.command ? { command: task.command } : {}),
      });
    }
  }
  out.sort((a, b) => String(b.enqueued_at || "").localeCompare(String(a.enqueued_at || "")));
  return typeof limit === "number" ? out.slice(0, limit) : out;
}

// 各狀態目錄的 .json 數量。額外給 review = done 但尚未驗收的數量(供「待驗收 / 完成」拆分)。
function statusCounts(queueDir) {
  const counts = {
    judging: 0, judged: 0, pending: 0, processing: 0, done: 0, failed: 0, blocked: 0, review: 0,
    unverified: 0, publishing: 0, publish_failed: 0, published: 0,
  };
  let unverifiedDone = 0;
  for (const status of STATUS_DIRS) {
    try {
      const files = fs.readdirSync(path.join(queueDir, status)).filter((f) => f.endsWith(".json"));
      counts[status] = files.length;
      if (status === "done") {
        for (const file of files) {
          const id = file.replace(/\.json$/, "");
          let approval = null;
          try { approval = findApproval(queueDir, id); }
          catch (_) { counts.publish_failed++; continue; }
          if (approval && ["pending", "processing"].includes(approval.status)) counts.publishing++;
          else if (approval && approval.status === "failed") counts.publish_failed++;
          else if ((approval && approval.status === "done") || isVerified(queueDir, id)) counts.published++;
          else unverifiedDone++;
        }
      }
    } catch (_) {}
  }
  counts.unverified = unverifiedDone;
  counts.review += unverifiedDone;
  return counts;
}

// 解析任務日誌:logs/<id>.log 優先,其次 failed/<id>.json.error.txt,都沒有則占位。
function resolveTaskLog(queueDir, taskId) {
  try {
    return { source: "log", text: fs.readFileSync(path.join(queueDir, "logs", taskId + ".log"), "utf8") };
  } catch (_) {}
  try {
    return { source: "error", text: fs.readFileSync(path.join(queueDir, "failed", taskId + ".json.error.txt"), "utf8") };
  } catch (_) {}
  return { source: "none", text: "executor 尚未寫入日誌" };
}

// messages.jsonl 尾段 n 筆,逐行 parse,新到舊。
function readMessagesTail(outputFile, n) {
  let raw;
  try {
    raw = fs.readFileSync(outputFile, "utf8");
  } catch (_) {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean).slice(-n);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {}
  }
  return out.reverse();
}

// 解析 queue/logs/<id>.log 的 NDJSON → { steps:[{key,label,status,ms,note}], summary|null, aiOutput|null }。
// 同一 step 多行取最新;summary 取最後一個有頂層 status 的物件;aiOutput 為 ai_run 步驟的 Codex 實際輸出。
function parseProgress(queueDir, id) {
  let raw;
  try { raw = fs.readFileSync(path.join(queueDir, "logs", id + ".log"), "utf8"); }
  catch (_) { return { steps: [], summary: null, aiOutput: null, links: [] }; }

  const order = [];
  const byKey = {};
  let summary = null;
  let aiOutput = null;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch (_) { continue; }
    if (Array.isArray(o.steps)) {
      for (const st of o.steps) {
        if (!byKey[st.key]) { byKey[st.key] = { key: st.key, label: st.label, status: "pending" }; order.push(st.key); }
        else byKey[st.key].label = st.label;
      }
    } else if (o.step) {
      if (!byKey[o.step]) { byKey[o.step] = { key: o.step, label: o.step, status: "pending" }; order.push(o.step); }
      if (o.status != null) byKey[o.step].status = o.status;
      if (o.ms != null) byKey[o.step].ms = o.ms;
      if (o.note != null) byKey[o.step].note = o.note;
    } else if (typeof o.ai_output === "string") {
      aiOutput = o.ai_output;
    } else if (typeof o.status === "string") {
      summary = o;
    }
  }
  const output = aiOutput || (summary && summary.output) || "";
  return { steps: order.map((k) => byKey[k]), summary, aiOutput, links: extractAcceptanceLinks(output) };
}

// 任務是否已被人工驗收(work/<id>/verified.json 存在)。
function isVerified(queueDir, id) {
  return fs.existsSync(path.join(queueDir, "work", id, "verified.json"));
}

module.exports = { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, parseProgress, isVerified, STATUS_DIRS };
