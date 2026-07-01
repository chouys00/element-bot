"use strict";
const fs = require("fs");
const path = require("path");

// 任務通知設定:存於 storage/notify-config.json。bot 每次發送前現讀,故 dashboard 改設定免重啟 bot。
//   enabled    是否啟用通知
//   room_id    通知要發到哪個房間(bot 帳號必須已加入該房間才發得出去)
//   notify_on  "all" 全部成功/失敗都通知;"failed_only" 只在失敗時通知(降噪,保留供未來)
const DEFAULTS = { enabled: false, room_id: "", notify_on: "all" };

function configPath(storageDir) {
  return path.join(storageDir, "notify-config.json");
}

// 讀設定;檔不存在/壞掉 → 回預設(通知停用),不丟錯。
function readNotifyConfig(storageDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(storageDir), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...raw };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

// 驗證設定;非法丟 Error(供 PUT endpoint 擋下壞資料、不覆寫原檔)。
function validateNotifyConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("設定必須為物件");
  if (typeof cfg.enabled !== "boolean") throw new Error("enabled 必須為布林");
  if (cfg.room_id !== undefined && typeof cfg.room_id !== "string") throw new Error("room_id 必須為字串");
  if (cfg.enabled && !cfg.room_id) throw new Error("啟用通知時必須指定通知房間");
  if (cfg.notify_on !== undefined && !["all", "failed_only"].includes(cfg.notify_on)) {
    throw new Error("notify_on 必須為 all 或 failed_only");
  }
  return true;
}

// 驗證後原子寫入(只保留已知欄位)。回傳落地後的完整設定。
function writeNotifyConfig(storageDir, cfg) {
  validateNotifyConfig(cfg);
  fs.mkdirSync(storageDir, { recursive: true });
  const merged = { ...DEFAULTS, ...cfg };
  const clean = { enabled: merged.enabled, room_id: merged.room_id, notify_on: merged.notify_on };
  const tmp = configPath(storageDir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(tmp, configPath(storageDir));
  return clean;
}

module.exports = { readNotifyConfig, writeNotifyConfig, validateNotifyConfig, DEFAULTS };
