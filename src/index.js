"use strict";
const sdk = require("matrix-js-sdk");
const { loadConfig } = require("./config");
const { acquireLock } = require("./lock");
const { loginNewDevice, buildCryptoClient } = require("./matrixClient");
const { establishTrust } = require("./trust");
const { pruneOldDevices } = require("./devices");
const { normalize } = require("./normalize");
const { shouldCapture, toRecord } = require("./handler");
const { writeEvent, OUTPUT_FILE } = require("./writer");
const { loadRules } = require("./rules");
const { watchRules, reloadRules } = require("./rulesWatcher");
const { runTriggerPipeline } = require("./trigger");
const { judge } = require("./judge");
const { enqueueTask } = require("./enqueue");
const path = require("path");
const fs = require("fs");
const { startHeartbeat } = require("./heartbeat");
const { processNotifyFile, drainNotifyDir } = require("./notifySender");
const { readNotifyConfig } = require("./notifyConfig");
const { lifecycleMessage } = require("./notify");
const {
  writeRoomsSidecar,
  buildRoomEntries,
  readRoomsMap,
  mergeRoomEntries,
  collectQueueRoomIds,
  resolveRoomNames,
} = require("./roomsSidecar");

// 等待首次 sync 完成(PREPARED),crypto 才會有自己的 public identity 可供建立信任。
function waitForPrepared(client) {
  return new Promise((resolve, reject) => {
    client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === "PREPARED") resolve();
      if (state === "ERROR") reject(new Error("初次 sync 失敗"));
    });
  });
}

async function main() {
  const config = loadConfig();
  acquireLock();

  console.log("[element-bot] 登入新裝置中...");
  const session = await loginNewDevice(config);
  console.log(`[element-bot] 已登入 ${session.userId}（device=${session.deviceId}）`);

  const client = await buildCryptoClient({
    homeserver: config.homeserver,
    session,
    recoveryKey: config.recoveryKey,
  });

  const STORAGE_DIR = path.resolve(__dirname, "..", "storage");

  let rules = [];
  try {
    rules = loadRules(config.rulesPath);
    console.log(`[element-bot] 載入 ${rules.length} 條觸發規則`);
  } catch (e) {
    console.warn("[element-bot] 規則載入失敗,觸發功能停用:", e.message);
  }

  // 熱載入:監看規則檔變動(dashboard 編輯存檔後),重讀換掉記憶體規則,免重啟 bot。
  // rules 是 let 且被 processEvent 閉包捕捉,重新賦值即對後續觸發生效。
  try {
    watchRules(config.rulesPath, () => { rules = reloadRules(config.rulesPath, rules, console); });
    console.log(`[element-bot] 已監看規則檔變動,將自動熱載入:${config.rulesPath}`);
  } catch (e) {
    console.warn("[element-bot] 無法監看規則檔,熱載入停用(仍可手動重啟套用):", e.message);
  }

  // 用 claude CLI(headless）做 LLM 判斷,吃目前登入帳號的 quota,不需 API key。
  // CLI 不存在/逾時/非零 exit 會丟錯,被 trigger 的 per-rule try/catch 接住 → 該則不觸發,bot 照常。
  const judgeFn = async (rule, message) => judge(rule, message);

  const seen = new Set(); // 以 event_id 去重(timeline 與 Decrypted 可能各觸發一次)
  const startTs = Date.now();

  async function processEvent(event) {
    try {
      if (event.isEncrypted() && event.isDecryptionFailure()) {
        console.warn(`[element-bot] ⚠️ 解密失敗 @ ${event.getRoomId()} ${event.getId()}（等待金鑰）`);
        return;
      }
      const rec = normalize(event);
      if (!shouldCapture(rec.room_id, rec, { roomIds: config.roomIds, startTs })) return;
      if (seen.has(rec.event_id)) return;
      seen.add(rec.event_id);
      writeEvent(toRecord(rec.room_id, rec));
      console.log(`[element-bot] 已擷取 ${rec.room_id} <- ${rec.sender}: ${String(rec.content.body).slice(0, 80)}`);
      try {
        await runTriggerPipeline(rec, {
          rules,
          judgeFn,
          enqueueFn: (task) => enqueueTask(config.queueDir, task),
          logger: console,
        });
      } catch (err) {
        console.error("[element-bot] 觸發管線錯誤(不影響擷取):", err.message);
      }
    } catch (err) {
      console.error("[element-bot] 處理事件錯誤:", err);
    }
  }

  // 即時 timeline 事件(只處理 live)。加密事件先嘗試解密。
  client.on(sdk.RoomEvent.Timeline, async (event, room, toStartOfTimeline, removed, data) => {
    if (toStartOfTimeline || !data || !data.liveEvent) return;
    if (event.isEncrypted()) {
      try { await client.decryptEventIfNeeded(event); } catch (_) {}
    }
    await processEvent(event);
  });

  // 晚到的金鑰(例如從 key backup 下載後)會重新解密並觸發 Decrypted。
  client.on(sdk.MatrixEventEvent.Decrypted, async (event) => {
    await processEvent(event);
  });

  // 只向伺服器訂閱指定房間的 room 事件(節省傳輸)。
  // to_device 是 sync 頂層欄位,不受 room filter 影響,E2EE 金鑰交換正常。
  const roomFilter = new sdk.Filter(session.userId);
  roomFilter.setDefinition({ room: { rooms: config.roomIds } });

  // 先啟動 sync 並等 PREPARED,讓 crypto 取得自身 identity,再建立信任。
  console.log("[element-bot] 啟動 sync...");
  await client.startClient({ initialSyncLimit: 1, filter: roomFilter });
  await waitForPrepared(client);

  // 房間名稱 sidecar:累積合併(不覆寫已知名稱),並替佇列中出現、
  // 但不在當前監聽清單的房間(含歷史任務)補查名稱,讓 dashboard 不顯示裸 room_id。
  const updateRooms = async () => {
    try {
      let merged = mergeRoomEntries(readRoomsMap(STORAGE_DIR), buildRoomEntries(client, config.roomIds));
      const missing = collectQueueRoomIds(config.queueDir).filter((id) => !merged[id] || merged[id] === id);
      if (missing.length) {
        merged = mergeRoomEntries(merged, await resolveRoomNames(client, missing));
      }
      writeRoomsSidecar(STORAGE_DIR, merged);
    } catch (e) {
      console.warn("[element-bot] 寫 rooms.json 失敗:", e.message);
    }
  };
  updateRooms();
  client.on(sdk.RoomEvent.Name, updateRooms);
  // 心跳:每 30s 寫一次存活時間戳,供儀表板判斷 bot 是否在線。
  startHeartbeat(STORAGE_DIR, 30000);

  // ── 任務通知:worker 沒有 Matrix client,任務結束後寫 queue/notify/<id>.json,
  //    由 bot 監看發送。通知房間/開關存於 storage/notify-config.json,發送前現讀故改設定免重啟。
  const notifyDir = path.join(config.queueDir, "notify");
  fs.mkdirSync(notifyDir, { recursive: true });
  const sendFn = (roomId, text) => client.sendTextMessage(roomId, text);
  const notifyDeps = { storageDir: STORAGE_DIR, sendFn, logger: console };
  await drainNotifyDir(config.queueDir, notifyDeps); // 清掉 bot 離線期間累積的通知
  try {
    fs.watch(notifyDir, (evt, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      const fp = path.join(notifyDir, filename);
      // 給原子寫入一點落地時間,並確認檔仍在(watch 可能對同一次寫入觸發多次)。
      setTimeout(() => {
        if (!fs.existsSync(fp)) return;
        processNotifyFile(fp, notifyDeps).catch(() => {});
      }, 50);
    });
    console.log(`[element-bot] 已監看任務通知佇列:${notifyDir}`);
  } catch (e) {
    console.warn("[element-bot] 無法監看通知佇列,任務通知停用:", e.message);
  }

  // bot 生命週期通知:啟動發「上線」;收到中止訊號發「下線」(盡力而為,可能因程序即刻結束而未送達)。
  const sendLifecycle = async (kind) => {
    const cfg = readNotifyConfig(STORAGE_DIR);
    if (!cfg.enabled || !cfg.room_id) return;
    try { await client.sendTextMessage(cfg.room_id, lifecycleMessage(kind)); } catch (_) {}
  };
  await sendLifecycle("online");
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { sendLifecycle("offline").finally(() => process.exit(0)); });
  }

  console.log("[element-bot] 用 recovery key 建立裝置信任 + 還原 key backup...");
  await establishTrust(client, { userId: config.userId, password: config.password });

  await pruneOldDevices(client, {
    deviceName: config.deviceName,
    currentDeviceId: session.deviceId,
    userId: config.userId,
    password: config.password,
  });

  console.log(`[element-bot] 已開始監聽 ${config.roomIds.length} 個房間。`);
  console.log(`[element-bot] 輸出檔: ${OUTPUT_FILE}`);
  console.log("[element-bot] 到 Element 對目標房間發訊息來驗證。Ctrl+C 結束。");
}

main().catch((err) => {
  console.error("[element-bot] 啟動失敗:", err);
  process.exit(1);
});
