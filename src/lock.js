"use strict";

// 單實例鎖:避免同一個裝置金鑰庫被兩個程序同時使用,
// 否則會造成 one-time key 上傳衝突而毀掉裝置(實測踩過)。
const fs = require("fs");
const path = require("path");
const STORAGE_DIR = path.resolve(__dirname, "..", "storage");

const LOCK_FILE = path.join(STORAGE_DIR, "bot.lock");

function isAlive(pid) {
  try {
    process.kill(pid, 0); // 不送訊號,只測存在
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但無權限 → 視為存活
  }
}

function acquireLock() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (pid && isAlive(pid)) {
      throw new Error(
        `偵測到另一個 element-bot 實例正在執行(PID ${pid})。` +
          `請勿同時開兩個,否則會毀掉裝置金鑰。先關掉那個再啟動。`
      );
    }
    // 殘留的過期鎖,清掉。
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");

  const release = () => {
    try {
      if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch (_) {}
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
}

module.exports = { acquireLock, LOCK_FILE };
