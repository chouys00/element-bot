"use strict";
const fs = require("fs");
const path = require("path");

// 把 room_id → 名稱 映射寫入 storage/rooms.json。
function writeRoomsSidecar(storageDir, entries) {
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "rooms.json"), JSON.stringify(entries, null, 2), "utf8");
}

// 讀 rooms.json;不存在/壞掉回空物件。
function readRoomsMap(storageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(storageDir, "rooms.json"), "utf8"));
  } catch (_) {
    return {};
  }
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

module.exports = { writeRoomsSidecar, readRoomsMap, translateRoom, buildRoomEntries };
