"use strict";
require("dotenv").config();
const path = require("path");

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

  const rulesPath = path.resolve(__dirname, "..", process.env.RULES_PATH || "config/rules.json");
  const queueDir = path.resolve(__dirname, "..", process.env.QUEUE_DIR || "queue");
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);
  const maxTaskAttempts = parseInt(process.env.MAX_TASK_ATTEMPTS || "3", 10);
  const maxApprovalAttempts = parseInt(process.env.MAX_APPROVAL_ATTEMPTS || "3", 10);

  const missing = [];
  if (!homeserver) missing.push("MATRIX_HOMESERVER");
  if (!userId) missing.push("MATRIX_USER_ID");
  if (!password) missing.push("MATRIX_PASSWORD");
  if (!recoveryKey) missing.push("MATRIX_RECOVERY_KEY");
  // 注意:MATRIX_ROOM_IDS 不再強制。監聽清單改由 storage/rooms-config.json 管理(dashboard 可編輯、
  // 熱載入),env 僅在該檔不存在時作為初始值/後備(見 roomsConfig.resolveRoomIds)。
  if (missing.length) {
    throw new Error(`缺少必要設定: ${missing.join(", ")}（請參考 .env.example）`);
  }
  return { homeserver, userId, password, recoveryKey, deviceName, roomIds, rulesPath, queueDir, pollIntervalMs, maxTaskAttempts, maxApprovalAttempts };
}

// 儀表板專用設定:只需路徑與埠,不要求 matrix 憑證,讓 dashboard 能獨立啟動。
function loadDashboardConfig() {
  return {
    queueDir: path.resolve(__dirname, "..", process.env.QUEUE_DIR || "queue"),
    storageDir: path.resolve(__dirname, "..", "storage"),
    outputFile: path.resolve(__dirname, "..", "output", "messages.jsonl"),
    rulesPath: path.resolve(__dirname, "..", process.env.RULES_PATH || "config/rules.json"),
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || "3000", 10),
    // 預設僅本機;要讓其他電腦連線,.env 設 DASHBOARD_HOST=0.0.0.0(或該機器區網 IP)。
    dashboardHost: process.env.DASHBOARD_HOST || "127.0.0.1",
    // 監聽清單後備:rooms-config.json 不存在時,dashboard 顯示 .env 的初始監聽房間。
    envRoomIds: parseRoomIds(process.env.MATRIX_ROOM_IDS),
  };
}

module.exports = { loadConfig, parseRoomIds, loadDashboardConfig };
