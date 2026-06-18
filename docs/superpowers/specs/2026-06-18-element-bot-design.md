# Element Bot — Design Spec（修訂版）
**Date:** 2026-06-18
**Status:** Approved（取代同日舊版；舊版未處理 E2EE,不可用）

## 目標

建立一支長駐的 Node.js 程序,連上自架 Matrix/Element homeserver,**即時監聽指定(可複數)聊天室**的新訊息,**解密 E2EE 內容**後,將每則訊息以 JSONL 格式寫入本地檔案,供後續 AI agent 分析。初期目標僅驗證能正確擷取「啟動後的新訊息」。

> ⚠️ 關鍵前提:公司所有房間預設 **E2EE 加密(m.megolm.v1.aes-sha2)**。因此解密是本專案的核心,不是後續擴充。

---

## 已定案的決策

| 主題 | 決策 | 理由 |
|------|------|------|
| 身分 | 用現有帳號 `@patrick.zyx` 做**全新 login → 新 device** | 解密需要擁有自身 crypto 金鑰庫的裝置;沿用舊 token 對應的 `CHXCAZXOOE` 裝置無法解密 |
| SDK | `matrix-bot-sdk` | 為 bot 而生,E2EE 金鑰庫**存磁碟**(原生 Rust binding),重啟不掉金鑰,擷取迴圈極簡 |
| Node | 22.x（實機 22.22.1） | `matrix-bot-sdk@0.8.0` 需 Node ≥22 |
| 擷取範圍 | 僅**啟動後新訊息**,不回溯歷史 | 符合「即時監聽」初期目標 |
| 裝置信任 | 從現有 Element session **手動 Verify** 新裝置 | 確保房間金鑰分享給 bot;recovery key 為備援 |

不會登出現有 session:Matrix 為多裝置模型,新增 device 只是多開一個 session。

---

## 環境

| 項目 | 值 |
|------|-----|
| Homeserver | `https://ims.opscloud.info` |
| 伺服器軟體 | Synapse 1.148.0 |
| 帳號 | `@patrick.zyx:ims.opscloud.info`（新 device,非 CHXCAZXOOE） |
| 初期監聽房間 | `!jOuxmbWVxsEbbcByqa:ims.opscloud.info` |

---

## 檔案結構

```
element-bot/
├── .env                 # 機密:homeserver / bot token / room ids /（選用）recovery key
├── .env.example         # 範本（進 git）
├── .gitignore           # 排除 .env、storage/、output/、node_modules/
├── package.json         # deps: matrix-bot-sdk, dotenv
├── login.js             # 一次性:密碼登入 → 取得新 device+token → 印出/寫回 .env
├── AGENT_CONTEXT.md     # 給下游 AI agent 看的資料說明（schema、欄位、使用方式）
├── src/
│   ├── config.js        # 讀取 .env、驗證必要設定
│   ├── client.js        # 建立 MatrixClient + 儲存層 + 金鑰庫
│   ├── writer.js        # append 一行 JSONL 到 output/messages.jsonl
│   ├── handler.js       # 過濾邏輯 → 交給 writer（純函式,可測試）
│   └── index.js         # 進入點:prepare crypto → 註冊 handler → start
├── storage/
│   ├── bot.json         # sync token（SimpleFsStorageProvider）
│   └── crypto/          # ★E2EE 金鑰庫（RustSdkCryptoStorageProvider,機密）
└── output/
    └── messages.jsonl   # 輸出（機密,含對話內容）
```

---

## 元件設計

### `login.js`（一次性）
- 互動輸入 `@patrick.zyx` 密碼（隱藏輸入,**不存檔**,只用於這次 `/login`）。
- 用 `MatrixAuth(homeserver).passwordLogin()` 取得新 `access_token` + `device_id`。
- 將 token 寫回 `.env`（或印出讓使用者貼上）。

### `src/config.js`
- 用 `dotenv` 載入,匯出 `{ homeserver, accessToken, roomIds[], recoveryKey? }`。
- 缺必要值時拋出明確錯誤。

### `src/client.js`
- `SimpleFsStorageProvider('storage/bot.json')` 存 sync token。
- `RustSdkCryptoStorageProvider('storage/crypto', ...)` 存 E2EE 金鑰。
- `new MatrixClient(homeserver, accessToken, storage, crypto)`,匯出 client。

### `src/handler.js`
- 匯出純函式 `shouldCapture(roomId, event, { roomIds, startTs, selfUserId })` → boolean:
  1. `roomIds.includes(roomId)`
  2. `event.type === 'm.room.message'` 且 `event.content?.body` 存在
  3. `event.origin_server_ts >= startTs`（濾掉 initial sync 舊訊息）
  4. `event.sender !== selfUserId`
- 通過則組裝精簡記錄交給 `writer`。

### `src/writer.js`
- `writeEvent(record)`:附加 `_received_at`(ISO),`fs.appendFileSync` 寫入 `output/messages.jsonl`(目錄不存在則建立)。

### `src/index.js`
- 建 client → `await client.crypto.prepare()` → 記 `startTs = Date.now()` → 取 `selfUserId`/`selfDeviceId`(getWhoAmI)→ `client.on('room.message', ...)` → `client.start()`。
- 監聽 `room.failed_decryption` 記錄解密失敗(便於診斷金鑰未分享問題)。

---

## 輸出格式（JSONL,每行一則解密後訊息）

```jsonl
{"event_id":"$abc","room_id":"!jOux...:ims.opscloud.info","sender":"@user:ims.opscloud.info","origin_server_ts":1718694123456,"type":"m.room.message","msgtype":"m.text","body":"明天的會議改到下午三點","_received_at":"2026-06-18T10:30:00.000Z"}
```

---

## 安全考量
- `.env`、`storage/`（含 crypto 金鑰）、`output/`、`node_modules/` 全部 `.gitignore`。
- access token、recovery key 視為最高機密,絕不進 git。
- 初期用個人帳號的新裝置;正式上線建議改專屬 bot 帳號。
- 目前非 git repo;是否 `git init` 由使用者決定。

---

## 驗證方式
1. `node login.js` → 取得 token 寫入 `.env`。
2. 從現有 Element session 驗證新裝置（Verify session）。
3. `node src/index.js` 啟動。
4. 在 Element 對目標房間發一則訊息。
5. 確認 `output/messages.jsonl` 新增一行,且 `body` 為正確明文。

---

## 風險 / 待實作確認
- matrix-bot-sdk 以 recovery key 自我簽署的 API 支援度（主路徑用手動驗證可規避）。
- 原生 crypto 模組在 Windows/Node 22 安裝(預期有預編 binary)。
- 若公司啟用「只發送給已驗證裝置」,手動驗證為**必要**。

---

## 未來擴充（不在本 spec 範圍）
- 依訊息內容觸發 AI agent（Claude API）。
- 解密歷史訊息（需 recovery key 還原 key backup,可能改用 matrix-js-sdk）。
- 換專屬 bot 帳號;輸出改資料庫 / message queue。
