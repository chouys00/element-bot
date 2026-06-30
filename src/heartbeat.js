"use strict";
const fs = require("fs");
const path = require("path");

// 時間戳是否在 maxAgeMs 內(用來判斷 bot 是否存活)。
function isFresh(ts, now, maxAgeMs) {
  return typeof ts === "number" && ts > 0 && now - ts <= maxAgeMs;
}

// 讀心跳檔,回傳毫秒時間戳;檔案不存在/壞掉回 null。
function readHeartbeat(storageDir) {
  try {
    const ts = parseInt(fs.readFileSync(path.join(storageDir, "bot-heartbeat"), "utf8").trim(), 10);
    return Number.isNaN(ts) ? null : ts;
  } catch (_) {
    return null;
  }
}

// 把當下時間戳寫進心跳檔。
function writeHeartbeat(storageDir) {
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), String(Date.now()), "utf8");
}

// 立即寫一次,之後每 intervalMs 寫一次。回傳停止函式。timer.unref 避免擋住程序退出。
function startHeartbeat(storageDir, intervalMs) {
  writeHeartbeat(storageDir);
  const timer = setInterval(() => writeHeartbeat(storageDir), intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { isFresh, readHeartbeat, writeHeartbeat, startHeartbeat };
