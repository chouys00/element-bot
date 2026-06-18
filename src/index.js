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

  // 先啟動 sync 並等 PREPARED,讓 crypto 取得自身 identity,再建立信任。
  console.log("[element-bot] 啟動 sync...");
  await client.startClient({ initialSyncLimit: 1 });
  await waitForPrepared(client);

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
