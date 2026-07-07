"use strict";
const fs = require("fs");
const path = require("path");
const { readJsonSafe, writeJsonAtomic } = require("./fsUtils");

// 監聽房間清單:存於 storage/rooms-config.json,決定 bot 要擷取/觸發哪些房間。
//   room_ids   要監聽的房間 id 陣列(權威清單;rule.rooms 只能從中挑子集)
// 設計:這是「定義」清單,dashboard 可編輯 + 熱載入。.env 的 MATRIX_ROOM_IDS 只在
// 本檔不存在時作為初始值/後備(resolveRoomIds),避免炸現有部署。
const DEFAULTS = { room_ids: [] };

function configPath(storageDir) {
  return path.join(storageDir, "rooms-config.json");
}

// 正規化 room_ids:trim、去空、去重,保持原順序。
function normalizeIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// 讀設定;檔不存在/壞掉 → 回預設(空清單),不丟錯。
function readRoomsConfig(storageDir) {
  const raw = readJsonSafe(configPath(storageDir), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.room_ids)) {
    return { ...DEFAULTS };
  }
  return { room_ids: normalizeIds(raw.room_ids) };
}

// 驗證設定;非法丟 Error(供 PUT endpoint 擋下壞資料、不覆寫原檔)。空清單為合法。
function validateRoomsConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("設定必須為物件");
  if (!Array.isArray(cfg.room_ids)) throw new Error("room_ids 必須為陣列");
  if (cfg.room_ids.some((id) => typeof id !== "string")) throw new Error("room_ids 每一項必須為字串");
  return true;
}

// 驗證後原子寫入(只保留已知欄位,room_ids 正規化)。回傳落地後的完整設定。
function writeRoomsConfig(storageDir, cfg) {
  validateRoomsConfig(cfg);
  const clean = { room_ids: normalizeIds(cfg.room_ids) };
  return writeJsonAtomic(configPath(storageDir), clean);
}

// 決定 bot 啟動時的監聽清單:rooms-config.json 存在且可解析 → 用檔(含刻意清空的空清單);
// 檔不存在或壞掉 → 回退 fallbackIds(來自 .env 的 MATRIX_ROOM_IDS)。
function resolveRoomIds(storageDir, fallbackIds = []) {
  const raw = readJsonSafe(configPath(storageDir), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.room_ids)) {
    return [...fallbackIds];
  }
  return normalizeIds(raw.room_ids);
}

// 熱載入用:重讀並驗證,成功回新清單(含空清單),失敗(檔壞)沿用 current。
// 仿 rulesWatcher.reloadRules,靠回傳值表達結果,呼叫端負責 swap,故好測。
function reloadRoomIds(storageDir, current, logger) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(storageDir), "utf8"));
    validateRoomsConfig(raw);
    const next = normalizeIds(raw.room_ids);
    logger.log(`[rooms] 已熱載入監聽清單:${next.length} 個房間`);
    return next;
  } catch (e) {
    logger.warn(`[rooms] 監聽清單重載失敗,沿用前一版 ${current.length} 個:${e.message}`);
    return current;
  }
}

module.exports = {
  DEFAULTS,
  configPath,
  readRoomsConfig,
  validateRoomsConfig,
  writeRoomsConfig,
  resolveRoomIds,
  reloadRoomIds,
};
