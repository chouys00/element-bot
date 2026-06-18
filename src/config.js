"use strict";
require("dotenv").config();

function parseRoomIds(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadConfig() {
  const homeserver = process.env.MATRIX_HOMESERVER;
  const userId = process.env.MATRIX_USER_ID; // 可填 localpart 或完整 @user:server
  const password = process.env.MATRIX_PASSWORD;
  const recoveryKey = process.env.MATRIX_RECOVERY_KEY;
  const deviceName = process.env.MATRIX_DEVICE_NAME || "element-bot";
  const roomIds = parseRoomIds(process.env.MATRIX_ROOM_IDS);

  const missing = [];
  if (!homeserver) missing.push("MATRIX_HOMESERVER");
  if (!userId) missing.push("MATRIX_USER_ID");
  if (!password) missing.push("MATRIX_PASSWORD");
  if (!recoveryKey) missing.push("MATRIX_RECOVERY_KEY");
  if (roomIds.length === 0) missing.push("MATRIX_ROOM_IDS");
  if (missing.length) {
    throw new Error(`缺少必要設定: ${missing.join(", ")}（請參考 .env.example）`);
  }
  return { homeserver, userId, password, recoveryKey, deviceName, roomIds };
}

module.exports = { loadConfig, parseRoomIds };
