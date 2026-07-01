"use strict";
const fs = require("fs");
const path = require("path");
const { formatNotify } = require("./notify");
const { readNotifyConfig } = require("./notifyConfig");
const { readRoomsMap } = require("./roomsSidecar");

// bot 端:處理單一通知檔。讀 payload → 依設定決定是否發 → 發送 → 刪檔。
// deps = { storageDir, sendFn(roomId, text)->Promise, logger }
//   sendFn 由 bot 注入(包住 matrix client 的 sendTextMessage)。
// 回傳 "sent" | "skipped" | "bad" | "error"。
// 注意:先刪檔再發送(先「認領」),避免 fs.watch 可能的重複事件造成重複通知;
//       代價是若發送失敗該筆通知會遺失,對通知這種非關鍵訊息可接受。
async function processNotifyFile(filePath, deps) {
  const { storageDir, sendFn, logger, resolveSender } = deps;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    try { fs.rmSync(filePath, { force: true }); } catch (_) {}
    return "bad";
  }
  try { fs.rmSync(filePath, { force: true }); } catch (_) {}

  const cfg = readNotifyConfig(storageDir);
  if (!cfg.enabled || !cfg.room_id) return "skipped";
  if (cfg.notify_on === "failed_only" && payload.status !== "failed") return "skipped";

  // 即時解析發送者在來源房間的顯示名(bot 在該房間才查得到);查不到則 formatNotify 退回 @localpart。
  let senderName;
  const src = payload.source || {};
  if (resolveSender && src.sender) {
    try { senderName = await resolveSender(src.room_id, src.sender); } catch (_) {}
  }
  const text = formatNotify(payload, { rooms: readRoomsMap(storageDir), senderName });
  try {
    await sendFn(cfg.room_id, text);
    return "sent";
  } catch (e) {
    if (logger) logger.error("[element-bot] 發送任務通知失敗:", e.message);
    return "error";
  }
}

// bot 啟動時清掉 queue/notify/ 內既有的通知檔(bot 離線期間 worker 可能已累積)。回傳處理筆數。
async function drainNotifyDir(queueDir, deps) {
  const dir = path.join(queueDir, "notify");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (_) { return 0; }
  let n = 0;
  for (const f of files.sort()) {
    await processNotifyFile(path.join(dir, f), deps);
    n++;
  }
  return n;
}

module.exports = { processNotifyFile, drainNotifyDir };
