"use strict";
const fs = require("fs");
const path = require("path");

// 確保目錄存在(遞迴建立);回傳 dir 方便串接。
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 安全讀 JSON:檔不存在/壞掉回 fallback,不丟錯。
function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

// 原子寫 JSON:先寫 .tmp 再 rename,任何時點中斷都留完整檔,
// 讀端(含 bot 的 fs.watch)不會讀到寫一半的檔。會自動建立父目錄。
function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return data;
}

module.exports = { ensureDir, readJsonSafe, writeJsonAtomic };
