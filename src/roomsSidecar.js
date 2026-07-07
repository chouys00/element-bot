"use strict";
const fs = require("fs");
const path = require("path");
const { readJsonSafe, writeJsonAtomic } = require("./fsUtils");

// 把 room_id → 名稱 映射寫入 storage/rooms.json。
function writeRoomsSidecar(storageDir, entries) {
  writeJsonAtomic(path.join(storageDir, "rooms.json"), entries);
}

// 讀 rooms.json;不存在/壞掉回空物件。
function readRoomsMap(storageDir) {
  return readJsonSafe(path.join(storageDir, "rooms.json"), {});
}

// 用映射翻譯 room_id;查不到回退顯示原 id。
function translateRoom(roomId, roomsMap) {
  if (roomsMap && roomId && roomsMap[roomId]) return roomsMap[roomId];
  return roomId;
}

// 從 matrix client 與受監聽房間列表建出 id→name 映射(查不到名稱用 id 占位)。
function buildRoomEntries(client, roomIds) {
  const entries = {};
  for (const id of roomIds) {
    const room = client && client.getRoom ? client.getRoom(id) : null;
    entries[id] = (room && room.name) || id;
  }
  return entries;
}

// 合併兩張 room_id→名稱 對照表。偏好「真實名稱」(value !== key,即非 id 回退):
// fresh 的真實名稱會覆蓋舊值;但若 fresh 只是 id 回退而既有已是真實名稱,則保留既有(不降級)。
function mergeRoomEntries(existing, fresh) {
  const out = { ...(existing || {}) };
  for (const [id, name] of Object.entries(fresh || {})) {
    const freshIsReal = name && name !== id;
    const haveReal = out[id] && out[id] !== id;
    if (freshIsReal || !haveReal) out[id] = name;
  }
  return out;
}

// 掃 queue/{pending,processing,done,failed} 的任務檔,回傳去重後的 source.room_id 陣列。
// 容錯:壞 JSON / 缺目錄略過。
function collectQueueRoomIds(queueDir) {
  const ids = new Set();
  for (const status of ["pending", "processing", "done", "failed"]) {
    let files;
    try {
      files = fs.readdirSync(path.join(queueDir, status));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const task = JSON.parse(fs.readFileSync(path.join(queueDir, status, f), "utf8"));
        const id = task && task.source && task.source.room_id;
        if (id) ids.add(id);
      } catch (_) {}
    }
  }
  return [...ids];
}

// 解析每個 room_id 的名稱:先試 client.getRoom(id)?.name(已 sync 的房間),
// 否則用 client.getStateEvent 直接查 m.room.name(繞過 sync filter);全失敗回退 id。
async function resolveRoomNames(client, roomIds) {
  const out = {};
  for (const id of roomIds) {
    let name;
    try {
      const room = client && client.getRoom ? client.getRoom(id) : null;
      if (room && room.name) name = room.name;
      if (!name && client && client.getStateEvent) {
        const ev = await client.getStateEvent(id, "m.room.name", "");
        if (ev && ev.name) name = ev.name;
      }
    } catch (_) {}
    out[id] = name || id;
  }
  return out;
}

module.exports = {
  writeRoomsSidecar,
  readRoomsMap,
  translateRoom,
  buildRoomEntries,
  mergeRoomEntries,
  collectQueueRoomIds,
  resolveRoomNames,
};
