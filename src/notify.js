"use strict";
const fs = require("fs");
const path = require("path");
const { readLogLines } = require("./executors/agentExecutor");

// 截斷過長字串(失敗原因可能是一整段 stack,只留重點避免通知太長)。
function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n).trimEnd() + " …" : s;
}

// 從任務 log 最後一行的 summary 取成功摘要(由 summarize 步驟用固定程式碼產出,非 AI,不耗 token)。
function readSummaryFromLog(queueDir, id) {
  const lines = readLogLines(queueDir, id);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] && typeof lines[i].summary === "string" && lines[i].summary) return lines[i].summary;
  }
  return "";
}

// worker 端:任務結束後,把一筆通知寫進 queue/notify/<id>.json,供 bot 監看發送。
// info = { queueDir, id, status:"done"|"failed", task, error }
function writeNotifyFile(info) {
  const { queueDir, id, status, task, error } = info;
  const notifyDir = path.join(queueDir, "notify");
  fs.mkdirSync(notifyDir, { recursive: true });
  const summary = status === "done" ? readSummaryFromLog(queueDir, id) : truncate(error, 200);
  const payload = {
    status,
    rule: (task && task.rule) || "",
    task: (task && task.task) || "",
    source: (task && task.source) || {},
    summary,
    ts: new Date().toISOString(),
  };
  const dest = path.join(notifyDir, id + ".json");
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, dest); // 原子落地:bot 的 fs.watch 讀到時一定是完整檔
  return payload;
}

// 把 Matrix 使用者 id 縮短成 localpart:@patrick.zyx:ims.opscloud.info → @patrick.zyx。
// 非預期格式(無「:」)則原樣回傳。
function shortSender(sender) {
  const s = String(sender == null ? "" : sender);
  const i = s.indexOf(":");
  return i > 0 ? s.slice(0, i) : s;
}

// bot 端:把通知 payload 套成訊息文字(範本 B + 免費短摘要,兩行)。rooms = 房間 id→名 map。
//   ✅「規則名」完成 · 〈房間名〉@發送者
//      摘要
function formatNotify(payload, rooms = {}) {
  const icon = payload.status === "done" ? "✅" : "❌";
  const verb = payload.status === "done" ? "完成" : "失敗";
  const label = payload.rule || payload.task || "任務";
  const src = payload.source || {};
  const roomName = (src.room_id && rooms[src.room_id]) || src.room_id || "未知房間";
  const sender = src.sender ? ` ${shortSender(src.sender)}` : "";
  const line1 = `${icon}「${label}」${verb} · 〈${roomName}〉${sender}`.trimEnd();
  return payload.summary ? `${line1}\n${payload.summary}` : line1;
}

// bot 生命週期訊息(上線/下線)。
function lifecycleMessage(kind) {
  return kind === "online" ? "🟢 element-bot 已上線" : "🔴 element-bot 下線中";
}

module.exports = { writeNotifyFile, formatNotify, lifecycleMessage, truncate, readSummaryFromLog, shortSender };
