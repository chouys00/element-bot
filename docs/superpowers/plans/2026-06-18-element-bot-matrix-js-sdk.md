# element-bot（matrix-js-sdk 改版）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 matrix-js-sdk 改寫 element-bot 的「連線 + 解密」層,靠使用者的 Secure Backup recovery key 建立裝置信任並還原 key backup,讓 bot 能在「只把金鑰分享給已驗證裝置」的公司環境下,即時解密並擷取指定加密房間的新訊息到 JSONL。

**Architecture:** 每次啟動 → 用帳密做「全新裝置」登入 → 初始化記憶體版 Rust crypto → 用 recovery key 存取 Secret Storage(4S)→ ① cross-sign 自我驗證本裝置 ② 載入並啟用 key backup(SDK 會持續從伺服器備份下載房間金鑰)→ 開始 sync,監聽 timeline,過濾後將解密明文寫入 `output/messages.jsonl`。crypto 不持久化(Node 無可靠磁碟 IndexedDB),改由 recovery key 在每次開機時重建信任;舊的 bot 裝置在登入時順手清除,避免裝置清單膨脹。

**Tech Stack:** Node.js ≥22、matrix-js-sdk `41.7.0`(pinned）、`@matrix-org/matrix-sdk-crypto-wasm`(隨附）、`fake-indexeddb`（Node 的 IndexedDB 墊片,安全網）、`dotenv`。沿用既有 `dotenv` 設定與 JSONL 輸出。

---

## 背景與前置事實（實作者必讀）

- Homeserver `https://ims.opscloud.info`（Synapse 1.148.0）。帳號 `@patrick.zyx:ims.opscloud.info`。目標房間 `!jOuxmbWVxsEbbcByqa:ims.opscloud.info`,**已 E2EE 加密**;公司所有房間預設加密。
- **為何不用 matrix-bot-sdk:** 實測它的 CryptoClient 沒有 cross-signing / secret-storage / key-backup API,無法用 recovery key,也無法讓裝置受信任;而本環境只把金鑰分享給已驗證裝置 → 解不開。詳見 spec。
- **為何每次新登入 + 記憶體 crypto:** matrix-js-sdk 的 Rust crypto 在 Node 沒有可靠的磁碟持久化(IndexedDB 在 Node 僅記憶體)。重用 device_id 需要持久化裝置金鑰,否則重開時會用同一 device_id 上傳不同裝置金鑰而被 Synapse 拒絕(裝置金鑰不可變)。因此採「每次全新裝置 + 記憶體 crypto」,用 recovery key 在開機時還原信任與金鑰。
- **recovery key 是機密**,只放 `.env`(已 gitignore)。`.env` 還會放帳號密碼(自動化登入用)—— 與 recovery key 同等機密層級,皆不進 git。

## 既有可重用檔案（不需重寫,僅微調）
- `src/config.js` — 擴充欄位(user / password / recoveryKey / deviceName）。
- `src/handler.js` — 純函式 `shouldCapture` / `toRecord` **維持原樣**(改由 index.js 把 MatrixEvent 正規化成純物件再餵入）。
- `src/writer.js` — JSONL 輸出,**維持原樣**。
- `src/lock.js` — 單實例鎖;僅調整 storage 路徑來源(不再依賴 bot-sdk 的 client.js）。
- `AGENT_CONTEXT.md`、輸出格式 — 維持。

## 將被移除 / 取代
- `src/client.js`（matrix-bot-sdk 版）→ 由 `src/matrixClient.js`（matrix-js-sdk 版）取代。
- `login.js`（bot-sdk 版,單獨產 token）→ 移除;登入併入啟動流程。
- `matrix-bot-sdk` 依賴 → 移除。

## 檔案結構（完成後）
```
element-bot/
├── .env / .env.example / .gitignore / package.json
├── AGENT_CONTEXT.md / README.md
├── src/
│   ├── config.js          # 設定載入 + 驗證（擴充）
│   ├── matrixClient.js     # 登入(新裝置) + 建立啟用 crypto 的 client（新）
│   ├── trust.js            # 用 recovery key 建立裝置信任 + 還原 key backup（新）
│   ├── devices.js          # 登入時清除舊的 element-bot 裝置（新）
│   ├── normalize.js        # MatrixEvent → 純物件（新，給 handler 用）
│   ├── handler.js          # shouldCapture / toRecord（沿用）
│   ├── writer.js           # JSONL 輸出（沿用）
│   ├── lock.js             # 單實例鎖（微調）
│   └── index.js            # 進入點:登入→crypto→trust→sync→監聽（改寫）
├── storage/                # 僅放 bot.lock（crypto 不落地）
├── output/messages.jsonl   # 輸出
├── test/
│   ├── handler.test.js     # 沿用
│   └── normalize.test.js   # 新增
└── docs/superpowers/...    # spec + 本計畫
```

---

### Task 1: 切換相依套件並 pin 版本

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 移除 matrix-bot-sdk、加入 matrix-js-sdk 與 fake-indexeddb**

把 `package.json` 的 `dependencies` 改為:

```json
  "dependencies": {
    "dotenv": "^16.4.5",
    "fake-indexeddb": "^6.2.0",
    "matrix-js-sdk": "41.7.0"
  }
```

並把 `scripts` 改為（移除舊的 login）:

```json
  "scripts": {
    "start": "node src/index.js",
    "test": "node test/handler.test.js && node test/normalize.test.js"
  }
```

- [ ] **Step 2: 重裝相依**

Run: `npm install matrix-js-sdk@41.7.0 fake-indexeddb@^6.2.0 && npm uninstall matrix-bot-sdk`
Expected: 安裝成功,`node_modules/matrix-bot-sdk` 消失。

- [ ] **Step 3: 確認版本與關鍵匯出可用**

Run:
```bash
node -e "const s=require('matrix-js-sdk'); console.log(require('matrix-js-sdk/package.json').version, typeof s.createClient, s.RoomEvent.Timeline, s.MatrixEventEvent.Decrypted)"
```
Expected: 印出 `41.7.0 function Room.timeline Event.decrypted`（忽略 DeprecationWarning）。

- [ ] **Step 4: 刪除已不需要的舊檔**

Run: `rm -f src/client.js login.js`
Expected: 兩檔移除。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json && git commit -m "chore: switch to matrix-js-sdk, drop matrix-bot-sdk"
```
（若尚未 git init,跳過 commit 步驟,後續同理。）

---

### Task 2: 擴充 config

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`、`.env`

- [ ] **Step 1: 改寫 config.js**

```javascript
"use strict";
require("dotenv").config();

function parseRoomIds(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadConfig() {
  const homeserver = process.env.MATRIX_HOMESERVER;
  const userId = process.env.MATRIX_USER_ID;        // 可填 localpart 或完整 @user:server
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
```

- [ ] **Step 2: 更新 .env.example**

```
MATRIX_HOMESERVER=https://ims.opscloud.info
MATRIX_USER_ID=@patrick.zyx:ims.opscloud.info
MATRIX_PASSWORD=
MATRIX_RECOVERY_KEY=
MATRIX_ROOM_IDS=!jOuxmbWVxsEbbcByqa:ims.opscloud.info
MATRIX_DEVICE_NAME=element-bot
```

- [ ] **Step 3: 更新本機 .env**（填入實際密碼與 recovery key;此檔已 gitignore）

依 .env.example 補上 `MATRIX_USER_ID`、`MATRIX_PASSWORD`、`MATRIX_RECOVERY_KEY`,移除已不用的 `MATRIX_ACCESS_TOKEN`。

- [ ] **Step 4: 驗證載入**

Run: `node -e "console.log(Object.keys(require('./src/config').loadConfig()))"`
Expected: 印出 `[ 'homeserver', 'userId', 'password', 'recoveryKey', 'deviceName', 'roomIds' ]`（若 .env 未填齊則拋出明確錯誤,屬正常）。

- [ ] **Step 5: Commit**

```bash
git add src/config.js .env.example && git commit -m "feat(config): add login + recovery key settings"
```

---

### Task 3: normalize（MatrixEvent → 純物件）+ 沿用 handler

**Files:**
- Create: `src/normalize.js`
- Create: `test/normalize.test.js`
- 確認沿用: `src/handler.js`（不改）

- [ ] **Step 1: 先寫失敗測試 test/normalize.test.js**

```javascript
"use strict";
const assert = require("assert");
const { normalize } = require("../src/normalize");

// 用假的 MatrixEvent：只實作 normalize 會呼叫的方法
function fakeEvent(over = {}) {
  const d = {
    id: "$e1", room: "!r:hs", sender: "@a:hs", ts: 12345,
    type: "m.room.message", content: { msgtype: "m.text", body: "hi" },
    ...over,
  };
  return {
    getId: () => d.id,
    getRoomId: () => d.room,
    getSender: () => d.sender,
    getTs: () => d.ts,
    getType: () => d.type,
    getContent: () => d.content,
  };
}

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed++; };

const r = normalize(fakeEvent());
ok("event_id", r.event_id === "$e1");
ok("room_id", r.room_id === "!r:hs");
ok("sender", r.sender === "@a:hs");
ok("origin_server_ts", r.origin_server_ts === 12345);
ok("type", r.type === "m.room.message");
ok("content.body", r.content.body === "hi");

console.log(`normalize.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node test/normalize.test.js`
Expected: FAIL，`Cannot find module '../src/normalize'`。

- [ ] **Step 3: 實作 src/normalize.js**

```javascript
"use strict";
// 把 matrix-js-sdk 的 MatrixEvent 正規化成 handler 能吃的純物件。
// 注意:加密事件需在呼叫前已完成解密,getContent() 才會回傳明文。
function normalize(mxEvent) {
  return {
    event_id: mxEvent.getId(),
    room_id: mxEvent.getRoomId(),
    sender: mxEvent.getSender(),
    origin_server_ts: mxEvent.getTs(),
    type: mxEvent.getType(),
    content: mxEvent.getContent() || {},
  };
}
module.exports = { normalize };
```

- [ ] **Step 4: 跑兩個測試確認通過**

Run: `node test/normalize.test.js && node test/handler.test.js`
Expected: 兩者皆印出「N 項通過 ✅」。`handler.js` 因介面未變仍全綠。

- [ ] **Step 5: Commit**

```bash
git add src/normalize.js test/normalize.test.js && git commit -m "feat(normalize): MatrixEvent to plain record"
```

---

### Task 4: 建立登入 + 啟用 crypto 的 client

**Files:**
- Create: `src/matrixClient.js`

- [ ] **Step 1: 實作 src/matrixClient.js**

```javascript
"use strict";
// 提供 IndexedDB 全域(Node 安全網;記憶體版 crypto 通常不需要,但有些路徑會引用)。
require("fake-indexeddb/auto");
const sdk = require("matrix-js-sdk");

// 用帳密做「全新裝置」登入,回傳 { userId, deviceId, accessToken }。
async function loginNewDevice({ homeserver, userId, password, deviceName }) {
  const tmp = sdk.createClient({ baseUrl: homeserver });
  const res = await tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user: userId },
    password,
    initial_device_display_name: deviceName,
  });
  return { userId: res.user_id, deviceId: res.device_id, accessToken: res.access_token };
}

// 用登入結果建立一個啟用 Rust crypto(記憶體)的 client。
async function buildCryptoClient({ homeserver, session }) {
  const client = sdk.createClient({
    baseUrl: homeserver,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
  });
  // useIndexedDB:false → 記憶體 crypto store(不落地,符合本架構)。
  await client.initRustCrypto({ useIndexedDB: false });
  return client;
}

module.exports = { loginNewDevice, buildCryptoClient };
```

- [ ] **Step 2: 語法檢查**

Run: `node --check src/matrixClient.js && node -e "require('./src/matrixClient'); console.log('matrixClient 載入 OK')"`
Expected: 印出 `matrixClient 載入 OK`（忽略 Deprecation）。

- [ ] **Step 3: Commit**

```bash
git add src/matrixClient.js && git commit -m "feat(client): matrix-js-sdk login + rust crypto init"
```

> 註:此 Task 的真正功能驗證放在 Task 7 的端對端測試(需要真實帳密),這裡只確保可載入。

---

### Task 5: 用 recovery key 建立裝置信任 + 還原 key backup

**Files:**
- Create: `src/trust.js`

- [ ] **Step 1: 實作 src/trust.js**

```javascript
"use strict";
const { decodeRecoveryKey } = require("matrix-js-sdk/lib/crypto-api/recovery-key");

// 用 recovery key 建立信任:
//  1) 設定 getSecretStorageKey callback,讓 SDK 取得 4S 金鑰
//  2) bootstrapCrossSigning → 取出既有 cross-signing 私鑰並簽署本裝置(自我驗證)
//  3) 載入 + 啟用 key backup → SDK 之後會持續從伺服器備份下載房間金鑰
//  4) restoreKeyBackup → 立即拉一次現有金鑰
async function establishTrust(client, { recoveryKey, userId, password }) {
  const ssKey = decodeRecoveryKey(recoveryKey); // Uint8Array

  // SDK 需要 4S 金鑰時會呼叫這個 callback,回傳 [keyId, key]
  client.cryptoCallbacks = client.cryptoCallbacks || {};
  client.cryptoCallbacks.getSecretStorageKey = async ({ keys }) => {
    const keyId = Object.keys(keys)[0];
    if (!keyId) return null;
    return [keyId, ssKey];
  };

  const crypto = client.getCrypto();

  // UIA callback：上傳裝置簽章/簽署金鑰若需要密碼驗證時使用
  const authUploadDeviceSigningKeys = async (makeRequest) => {
    await makeRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password,
    });
  };

  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });

  // key backup：載入備份金鑰、啟用持續下載、並立即還原一次
  try {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  } catch (e) {
    console.warn("[trust] 載入 backup 金鑰失敗（可能未設定 key backup）:", e.message);
  }
  const backupCheck = await crypto.checkKeyBackupAndEnable();
  if (backupCheck) {
    try {
      const res = await crypto.restoreKeyBackup();
      console.log(`[trust] key backup 還原: 匯入 ${res.imported}/${res.total} 把金鑰`);
    } catch (e) {
      console.warn("[trust] restoreKeyBackup 失敗:", e.message);
    }
  } else {
    console.warn("[trust] 帳號沒有啟用中的 key backup;將僅靠裝置驗證後的直接金鑰分享。");
  }

  const ready = await crypto.isCrossSigningReady();
  console.log(`[trust] cross-signing ready = ${ready}`);
}

module.exports = { establishTrust };
```

- [ ] **Step 2: 語法檢查**

Run: `node --check src/trust.js && node -e "require('./src/trust'); console.log('trust 載入 OK')"`
Expected: 印出 `trust 載入 OK`。若 `require('matrix-js-sdk/lib/crypto-api/recovery-key')` 找不到,改用 `node -e "console.log(Object.keys(require('matrix-js-sdk')).filter(k=>/ecovery/i.test(k)))"` 找正確匯出後修正 import 路徑。

- [ ] **Step 3: Commit**

```bash
git add src/trust.js && git commit -m "feat(trust): establish device trust via recovery key + key backup"
```

---

### Task 6: 登入時清除舊的 element-bot 裝置

**Files:**
- Create: `src/devices.js`

- [ ] **Step 1: 實作 src/devices.js**

```javascript
"use strict";
// 刪除同名(element-bot)且非當前的舊裝置,避免每次新登入造成裝置清單膨脹。
// 刪除裝置需要 UIA(密碼）。失敗不致命,僅警告。
async function pruneOldDevices(client, { deviceName, currentDeviceId, userId, password }) {
  let list;
  try {
    list = await client.getDevices();
  } catch (e) {
    console.warn("[devices] 取得裝置清單失敗,略過清理:", e.message);
    return;
  }
  const targets = (list.devices || [])
    .filter((d) => d.display_name === deviceName && d.device_id !== currentDeviceId)
    .map((d) => d.device_id);
  if (targets.length === 0) return;

  try {
    await client.deleteMultipleDevices(targets, {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password,
    });
    console.log(`[devices] 已清除 ${targets.length} 個舊的 ${deviceName} 裝置`);
  } catch (e) {
    console.warn("[devices] 清除舊裝置失敗（不影響運作）:", e.message);
  }
}
module.exports = { pruneOldDevices };
```

- [ ] **Step 2: 語法檢查**

Run: `node --check src/devices.js && node -e "require('./src/devices'); console.log('devices 載入 OK')"`
Expected: 印出 `devices 載入 OK`。

- [ ] **Step 3: Commit**

```bash
git add src/devices.js && git commit -m "feat(devices): prune stale bot devices on login"
```

---

### Task 7: 微調 lock 並改寫 index.js（組裝 + 監聽）

**Files:**
- Modify: `src/lock.js`
- Modify (改寫): `src/index.js`

- [ ] **Step 1: 調整 src/lock.js 的 storage 路徑來源**（不再依賴已刪除的 client.js）

把開頭的
```javascript
const { STORAGE_DIR } = require("./client");
```
改為
```javascript
const STORAGE_DIR = require("path").resolve(__dirname, "..", "storage");
```
其餘不變（`acquireLock` 等）。

- [ ] **Step 2: 確認 lock 仍可載入**

Run: `node -e "require('./src/lock'); console.log('lock OK')"`
Expected: 印出 `lock OK`。

- [ ] **Step 3: 改寫 src/index.js**

```javascript
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

async function main() {
  const config = loadConfig();
  acquireLock();

  console.log("[element-bot] 登入新裝置中...");
  const session = await loginNewDevice(config);
  console.log(`[element-bot] 已登入 ${session.userId}（device=${session.deviceId}）`);

  const client = await buildCryptoClient({ homeserver: config.homeserver, session });

  console.log("[element-bot] 用 recovery key 建立裝置信任 + 還原 key backup...");
  await establishTrust(client, {
    recoveryKey: config.recoveryKey,
    userId: config.userId,
    password: config.password,
  });

  await pruneOldDevices(client, {
    deviceName: config.deviceName,
    currentDeviceId: session.deviceId,
    userId: config.userId,
    password: config.password,
  });

  const seen = new Set(); // 以 event_id 去重(timeline 與 Decrypted 可能各觸發一次)
  const selfUserId = session.userId;
  const startTs = Date.now();

  async function processEvent(event) {
    try {
      if (event.isEncrypted() && event.isDecryptionFailure()) {
        console.warn(`[element-bot] ⚠️ 解密失敗 @ ${event.getRoomId()} ${event.getId()}（等待金鑰）`);
        return;
      }
      const rec = normalize(event);
      if (!shouldCapture(rec.room_id, rec, { roomIds: config.roomIds, startTs, selfUserId })) return;
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

  await client.startClient({ initialSyncLimit: 1 });
  console.log(`[element-bot] 已開始監聽 ${config.roomIds.length} 個房間。`);
  console.log(`[element-bot] 輸出檔: ${OUTPUT_FILE}`);
  console.log("[element-bot] 到 Element 對目標房間發訊息來驗證。Ctrl+C 結束。");
}

main().catch((err) => {
  console.error("[element-bot] 啟動失敗:", err);
  process.exit(1);
});
```

- [ ] **Step 4: 語法檢查**

Run: `node --check src/index.js`
Expected: 無輸出(語法 OK)。

- [ ] **Step 5: Commit**

```bash
git add src/lock.js src/index.js && git commit -m "feat: wire matrix-js-sdk listener with trust + dedup"
```

---

### Task 8: 端對端驗證（需真實帳密 + Element 操作）

**Files:**（無程式變更,純驗證）

- [ ] **Step 1: 確認 .env 已填 MATRIX_USER_ID / MATRIX_PASSWORD / MATRIX_RECOVERY_KEY / MATRIX_ROOM_IDS**

Run: `node -e "const c=require('./src/config').loadConfig(); console.log('roomIds=', c.roomIds)"`
Expected: 印出目標房間;未填齊會明確報錯。

- [ ] **Step 2: 啟動 listener（單一實例!）**

Run: `npm start`
Expected log 順序(約 10–30 秒):
```
[element-bot] 登入新裝置中...
[element-bot] 已登入 @patrick.zyx:...（device=XXXX）
[element-bot] 用 recovery key 建立裝置信任 + 還原 key backup...
[trust] key backup 還原: 匯入 N/M 把金鑰
[trust] cross-signing ready = true
[element-bot] 已開始監聽 1 個房間。
```
若出現 `cross-signing ready = false` 或 backup 警告,記下訊息進入 Step 5 排查。

- [ ] **Step 3: 在 Element 對目標房間發一則新訊息**

例如「element-bot js-sdk 驗證」。

- [ ] **Step 4: 確認擷取成功**

Run: `cat output/messages.jsonl`
Expected: 至少一行,且該行 `body` 等於剛剛發送的明文,`room_id` 為目標房間。
同時 listener 主控台應印出 `已擷取 ...`。

✅ 達成此步即代表需求(即時擷取並解密加密房間新訊息)驗證通過。

- [ ] **Step 5: 若解密仍失敗的排查順序**

1. log 是否 `cross-signing ready = true`?否 → recovery key 是否正確、4S 是否有 cross-signing(在 Element「Security & Privacy」確認已設定 Secure Backup)。
2. `[trust] key backup 還原: 匯入 N` 的 N 是否 > 0?N=0 且帳號無 backup → 訊息需靠裝置驗證後的直接分享:稍候數秒再發一則(等其他端 /keys/query 看到本裝置已被 cross-sign)。
3. 仍失敗 → 在另一個 Element session 確認新裝置已顯示為「已驗證」。
4. 把完整啟動 log 貼回,逐項定位。

---

## Self-Review 紀錄

- **Spec 覆蓋:** 即時監聽(Task 7 timeline/Decrypted)、複數房間(config.roomIds + shouldCapture)、解密(Task 4/5 crypto+trust)、寫檔驗證(writer + Task 8)、安全(密鑰僅 .env / gitignore)、AI 文件(AGENT_CONTEXT 沿用)皆有對應。
- **Placeholder:** 無 TODO/TBD;每個程式步驟皆含完整程式碼。
- **型別一致:** `loginNewDevice` 回傳 `{userId, deviceId, accessToken}` 與 `buildCryptoClient({homeserver, session})`、`establishTrust(client, {recoveryKey,userId,password})`、`pruneOldDevices(client,{deviceName,currentDeviceId,userId,password})`、`normalize`→`shouldCapture/toRecord` 介面一致。
- **已知風險:** ① `require('matrix-js-sdk/lib/crypto-api/recovery-key')` 為深層匯入,版本已 pin 41.7.0;若改版需重找匯出(Task 5 Step 2 已給備援查法)。② `client.decryptEventIfNeeded` 若該版本無此方法,改為僅依賴 `MatrixEventEvent.Decrypted` 監聽(移除該行不影響晚到金鑰路徑)。
