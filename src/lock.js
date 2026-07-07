"use strict";

// 單實例鎖:避免同一個裝置金鑰庫被兩個程序同時使用,
// 否則會造成 one-time key 上傳衝突而毀掉裝置(實測踩過)。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureDir } = require("./fsUtils");

function lockPath(storageDir) {
  return path.join(storageDir, "bot.lock");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // 不送訊號,只測存在
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但無權限 → 視為存活
  }
}

// 讀某 PID 的完整命令列;查不到(權限不足/平台不支援/程序已死)回 null。
function getCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: "utf8", timeout: 3000 }
      );
      return out.trim() || null;
    }
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim() || null;
    }
    // macOS(及其他 BSD 系)沒有 /proc,改用 ps 查命令列。
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 });
    return out.trim() || null;
  } catch (_) {
    return null;
  }
}

// 命令列是否看起來像我們自己這支 bot(啟動腳本為 src/index.js)。
function looksLikeOurBot(cmdLine) {
  return typeof cmdLine === "string" && /index\.js/.test(cmdLine);
}

// 判斷某存活的 PID 是不是「我們自己這支 bot」,而非該 PID 被作業系統回收給了別的程式
// (實測踩過:舊 bot 用 kill -9 強殺、沒機會清鎖檔,PID 之後被完全無關的程式撿走,
// 導致 isAlive() 誤判「還在跑」)。查不到命令列時保守回 true——寧可誤判衝突,不可誤判為安全。
function isOurBotProcess(pid) {
  const cmd = getCommandLine(pid);
  if (cmd === null) return true;
  return looksLikeOurBot(cmd);
}

function acquireLock(storageDir) {
  ensureDir(storageDir);
  const lockFile = lockPath(storageDir);
  if (fs.existsSync(lockFile)) {
    const pid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    if (pid && isAlive(pid) && isOurBotProcess(pid)) {
      throw new Error(
        `偵測到另一個 element-bot 實例正在執行(PID ${pid})。` +
          `請勿同時開兩個,否則會毀掉裝置金鑰。先關掉那個再啟動。`
      );
    }
    // 殘留的過期鎖(程序已死,或 PID 已被作業系統回收給其他程式),清掉。
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, String(process.pid), "utf8");

  const release = () => {
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
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

module.exports = { acquireLock, lockPath, isOurBotProcess, looksLikeOurBot, getCommandLine };
