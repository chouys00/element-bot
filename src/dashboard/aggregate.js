"use strict";
const fs = require("fs");
const path = require("path");
const { translateRoom } = require("../roomsSidecar");

const STATUS_DIRS = ["pending", "processing", "done", "failed"];

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
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      let task;
      try {
        task = JSON.parse(fs.readFileSync(path.join(queueDir, status, f), "utf8"));
      } catch (_) {
        out.push({ id, status, parseError: true });
        continue;
      }
      const src = task.source || {};
      out.push({
        id,
        status,
        rule: task.rule,
        task: task.task,
        room_id: src.room_id,
        room_name: translateRoom(src.room_id, roomsMap),
        sender: src.sender,
        body: src.body,
        event_id: src.event_id,
        enqueued_at: task.enqueued_at,
      });
    }
  }
  out.sort((a, b) => String(b.enqueued_at || "").localeCompare(String(a.enqueued_at || "")));
  return typeof limit === "number" ? out.slice(0, limit) : out;
}

// 各狀態目錄的 .json 數量。
function statusCounts(queueDir) {
  const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const status of STATUS_DIRS) {
    try {
      counts[status] = fs.readdirSync(path.join(queueDir, status)).filter((f) => f.endsWith(".json")).length;
    } catch (_) {}
  }
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

module.exports = { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, STATUS_DIRS };
