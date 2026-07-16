"use strict";
const path = require("path");
const { writeJsonAtomic } = require("./fsUtils");
const { readLogLines } = require("./executors/agentExecutor");
const { extractHttpLinks } = require("./links");
const { formatTaskNumber } = require("./taskNumber");

// 截斷過長字串(失敗原因可能是一整段 stack,只留重點避免通知太長)。
function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n).trimEnd() + " …" : s;
}

// 從任務 log 由後往前取 Codex 完整 output；全程不新增 AI 呼叫。
function readSummaryFromLog(queueDir, id) {
  const lines = readLogLines(queueDir, id);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && typeof line.output === "string" && line.output) return line.output;
  }
  return "";
}

// worker 端:任務結束後,把一筆通知寫進 queue/notify/<id>.json,供 bot 監看發送。
// info = { queueDir, id, status:"done"|"failed", task, error }
function writeNotifyFile(info) {
  const { queueDir, id, status, task, error } = info;
  const notifyDir = path.join(queueDir, "notify");
  const summary = error ? truncate(error, 200) : readSummaryFromLog(queueDir, id);
  const payload = {
    id,
    task_number: formatTaskNumber(id),
    status,
    rule: (task && task.rule) || "",
    task: (task && task.task) || "",
    source: (task && task.source) || {},
    summary,
    links: extractHttpLinks(summary),
    ts: new Date().toISOString(),
  };
  return writeJsonAtomic(path.join(notifyDir, id + ".json"), payload); // 原子落地:bot 的 fs.watch 讀到時一定是完整檔
}

// 把 Matrix 使用者 id 縮短成 localpart:@patrick.zyx:ims.opscloud.info → @patrick.zyx。
// 非預期格式(無「:」)則原樣回傳。
function shortSender(sender) {
  const s = String(sender == null ? "" : sender);
  const i = s.indexOf(":");
  return i > 0 ? s.slice(0, i) : s;
}

// bot 端:把通知 payload 套成訊息文字(分行標籤,長內容各自成行避免爆版)。
// opts = { rooms: 房間 id→名 map, senderName: 已解析的發送者顯示名(優先於帳號 localpart) }
//   ✅「規則名」完成
//   聊天室:房間名
//   觸發人:發送者顯示名   ← 純文字標籤(非 emoji),明確是「誰發訊息觸發」而非「誰執行」,避免誤會成實作人
//   📝 摘要
function formatNotify(payload, opts = {}) {
  const { rooms = {}, senderName } = opts;
  const display = {
    done: ["✅", "完成"],
    failed: ["❌", "失敗"],
    blocked: ["⛔", "受阻"],
    review: ["⚠️", "部分完成"],
  };
  const [icon, verb] = display[payload.status] || ["❓", String(payload.status || "未知")];
  const label = payload.rule || payload.task || "任務";
  const src = payload.source || {};
  const roomName = (src.room_id && rooms[src.room_id]) || src.room_id || "未知房間";
  // 有顯示名用顯示名(如 Patrick.He.t),否則退回帳號 localpart(如 @patrick.zyx)。
  const who = senderName || shortSender(src.sender);
  const lines = [`${icon}「${label}」${verb}`, `聊天室:${roomName}`];
  const taskNumber = payload.task_number || formatTaskNumber(payload.id);
  if (taskNumber) lines.push(`任務編號:${taskNumber}`);
  if (src.sender) lines.push(`觸發人:${who}`);
  for (const url of Array.isArray(payload.links) ? payload.links : []) lines.push(`🔗 ${url}`);
  if (payload.summary) lines.push(`📝 ${payload.summary}`);
  return lines.join("\n");
}

// bot 生命週期訊息(上線/下線)。
function lifecycleMessage(kind) {
  return kind === "online" ? "🟢 element-bot 已上線" : "🔴 element-bot 下線中";
}

module.exports = { writeNotifyFile, formatNotify, lifecycleMessage, truncate, readSummaryFromLog, shortSender };
