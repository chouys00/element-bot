"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./fsUtils");

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
  ensureDir(storageDir);
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), String(Date.now()), "utf8");
}

// 保留心跳檔但把值設為離線，讓 dashboard 能立即反映 Matrix 已無法收訊息。
function markHeartbeatOffline(storageDir) {
  ensureDir(storageDir);
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), "0", "utf8");
}

// 心跳只跟 Matrix sync 狀態走：成功同步才在線，其餘狀態一律離線。
function startMatrixHeartbeat(client, storageDir) {
  markHeartbeatOffline(storageDir);
  const onSync = (state) => {
    if (state === "PREPARED" || state === "SYNCING") {
      writeHeartbeat(storageDir);
    } else {
      markHeartbeatOffline(storageDir);
    }
  };
  client.on("sync", onSync);
  return () => client.off("sync", onSync);
}

module.exports = {
  isFresh,
  readHeartbeat,
  writeHeartbeat,
  markHeartbeatOffline,
  startMatrixHeartbeat,
};
