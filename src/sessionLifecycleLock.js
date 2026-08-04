"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./fsUtils");

const STALE_LOCK_MS = 60 * 60 * 1000;

function safeTaskId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240 &&
    !value.includes("..") && !/[\\/\0]/.test(value);
}

function lifecycleLockPath(queueDir, taskId) {
  if (!safeTaskId(taskId)) throw new Error("session lifecycle lock task_id 不合法");
  return path.join(queueDir, "session-lifecycle-locks", `${taskId}.lock`);
}

function staleLock(file, nowMs) {
  try {
    return nowMs - fs.statSync(file).mtimeMs > STALE_LOCK_MS;
  } catch (error) {
    if (error && error.code === "ENOENT") return true;
    throw error;
  }
}

function acquireSessionLifecycleLock(queueDir, taskId, options = {}) {
  const file = lifecycleLockPath(queueDir, taskId);
  const nowMs = (options.nowMs || Date.now)();
  const token = `${process.pid}:${nowMs}:${Math.random().toString(36).slice(2)}`;
  ensureDir(path.dirname(file));

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, token, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file);
        } catch (_) {}
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (!error || error.code !== "EEXIST") throw error;
      if (attempt === 0 && staleLock(file, nowMs)) {
        try { fs.unlinkSync(file); } catch (unlinkError) {
          if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      const busy = new Error("Codex session 正在清理，請稍後再試");
      busy.code = "SESSION_CLEANUP_BUSY";
      throw busy;
    }
  }
  throw new Error("無法取得 session lifecycle lock");
}

module.exports = { acquireSessionLifecycleLock, lifecycleLockPath, STALE_LOCK_MS };
