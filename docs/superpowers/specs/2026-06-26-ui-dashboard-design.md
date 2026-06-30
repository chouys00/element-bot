# Element Bot 監控儀表板 — Design Spec

**Date:** 2026-06-26
**Status:** Approved
**前置:** 不取代 [2026-06-18-element-bot-design.md](2026-06-18-element-bot-design.md);本 spec 在其上新增「介面化」與連帶的佇列升級。

## 目標

為 `element-bot` 加上一個**本地網頁監控台**,讓使用者一目瞭然:
- 監聽到的訊息觸發了哪些任務。
- 每個任務當前狀態:**待處理 / 進行中 / 完成 / 失敗**。
- 點任務可看詳情與最終日誌,便於排查成功/失敗。

附帶一個**開發用**的「監聽訊息」區(可收合,標註之後移除)。

## 已定案的決策

| 主題 | 決策 | 理由 |
|------|------|------|
| 儀表板接法 | **方案 A:獨立第三個程序,只讀檔** | 延續現有 bot/worker 靠檔案系統解耦的設計,互不拖累 |
| 後端框架 | **Node 內建 `http`,不加 Express/框架** | 僅 ~4 條 GET 路由,框架的好處用不上,維持精簡依賴 |
| 前端 | **Vanilla JS + 單一 HTML,無建置步驟** | 一張表 + 一個面板,框架是過度工程;保留「丟著就能跑」 |
| 更新方式 | **前端輪詢 1–2s** | 本機單人,2s 延遲無感;避開 Windows `fs.watch` 不可靠的雷,複雜度最低 |
| 任務「進行中」狀態 | **新增 `queue/processing/` 目錄** | 延續「目錄即狀態」設計,最小改動 |
| 房間名稱 | **bot 寫 `storage/rooms.json`(id→name) sidecar** | room 名稱只在 bot 的 matrix client 記憶體;檔案只有 room_id |
| bot 連線狀態 | **bot 寫 `storage/bot-heartbeat` 時間戳** | 獨立程序無法直接得知 bot 是否存活,心跳檔最貼合檔案溝通架構 |
| 任務日誌 | **約定 `queue/logs/<task>.log`,executor 未來回寫** | 本次不做 executor 日誌格式;UI 先占位顯示 |
| 任務列呈現 | **平鋪(一列一任務)**、詳情走**右側面板**(master-detail) | 使用者已於 mockup 確認版面方向 |
| 綁定位址 | **`127.0.0.1` only,無登入** | 輸出含解密的公司訊息,極機密,絕不對外 |

## 架構

```
bot (src/index.js) ─┬─ output/messages.jsonl          ← 監聽訊息(dev 區來源)
                    ├─ storage/rooms.json    (新增)   ← room_id → 房間名稱
                    └─ storage/bot-heartbeat (新增)   ← 存活時間戳(每 30s 更新)

worker (src/worker.js) ── queue/
                          ├─ pending/      待處理
                          ├─ processing/   進行中 (新增)
                          ├─ done/         完成
                          ├─ failed/       失敗 (+ <task>.error.txt)
                          └─ logs/<task>.log   ← executor 未來回寫(本次占位)

dashboard (src/dashboard/ 新增) ── 只讀上述檔案 → HTTP API + 靜態前端
```

三程序各自獨立,只透過檔案系統溝通;儀表板對所有檔案皆為**唯讀**(本次不從 UI 改動佇列)。

## 後端改動

### worker(`src/workerCore.js`)
- `processOne` 流程改為:`pending/ → processing/`(開始執行前)→ 執行 executor → `done/` 或 `failed/`。
- `pollOnce` 只掃描 `pending/`,**不掃 `processing/`**(避免重入)。
- 既有「失敗寫 `<task>.error.txt`」行為保留。

### bot(`src/index.js` 及新模組)
- **rooms sidecar**:首次 sync PREPARED 後,以及房間名稱變動(`RoomState`/`m.room.name`)時,將所有受監聽房間的 `room_id → name` 寫入 `storage/rooms.json`。名稱取 `client.getRoom(roomId)?.name`。
- **heartbeat**:`setInterval` 每 30s 將 `Date.now()` 寫入 `storage/bot-heartbeat`。
- 兩者抽成各自的小模組(如 `src/roomsSidecar.js`、`src/heartbeat.js`)以利測試與隔離。

### 日誌約定
- 路徑:`queue/logs/<任務檔名去副檔名>.log`。
- executor 未來執行任務時往此檔回寫;本次 executor 仍為 dryRun,不產生此檔。
- UI 顯示規則:讀得到 → 顯示內容;讀不到 → 顯示「executor 尚未寫入日誌」;若任務在 `failed/` 且有 `<task>.error.txt` → 顯示該錯誤內容。

## 儀表板伺服器(`src/dashboard/`)

- 技術:Node 內建 `http`;靜態前端為單一 `index.html`(+ 內嵌或同目錄 JS/CSS),無建置。
- 綁定 `127.0.0.1`,埠由設定提供(預設如 `3000`,可經 `.env` 的 `DASHBOARD_PORT` 覆寫)。
- npm script:`npm run dashboard`。

### API(皆回 JSON,皆唯讀)

| 路由 | 說明 |
|------|------|
| `GET /api/tasks` | 合併 `pending/processing/done/failed` 四目錄,每筆:任務 id、狀態(=所在目錄)、規則、任務名、來源訊息(room_id、room 名稱經 rooms.json 翻譯、sender、body、event_id)、`enqueued_at`。預設回最近 N 筆(如 100),新到舊。 |
| `GET /api/tasks/:id/log` | 依日誌約定回該任務日誌文字(含占位 / error.txt fallback)。 |
| `GET /api/messages` | `output/messages.jsonl` 尾段 N 筆(dev 區用)。 |
| `GET /api/status` | bot heartbeat 新鮮度(線上/離線)+ 各狀態任務數量統計。 |

- 資料彙整/翻譯/狀態判定邏輯抽成**純函式**(便於單元測試),`http` handler 只做薄薄一層 I/O 串接。

## 前端

- 版面(已於 mockup 確認):
  - 頂部狀態列:bot 連線指示 + 各狀態任務數量。
  - **🔧 監聽訊息區**(開發用、可收合、標註之後移除):時間 / 聊天室 / 發送者 / 訊息內容。
  - **📋 觸發的任務表**(平鋪):時間 / 聊天室 / 發送者 / 規則→任務 / 狀態徽章。
  - **🔎 右側詳情面板**:點任務後顯示來源訊息、規則/任務、狀態,及日誌區(讀 `/api/tasks/:id/log`)。
- 每 1–2s 輪詢 `/api/tasks`、`/api/status`、`/api/messages` 重繪。
- 任務列表顯示最近 N 筆,新到舊。

## 錯誤處理 / 邊界

- **讀取競態**:worker 正 rename 任務檔時 UI 在讀 → API 對單檔錯誤容錯(略過該筆,不讓整個 `/api/tasks` 失敗)。
- **rooms.json 缺某 room**:回退顯示 `room_id`。
- **heartbeat 過期**(如 >60s 未更新)或檔案缺:頂部顯示「bot 離線」。
- **任務 JSON 損毀**:該筆標為解析失敗,不中斷整頁。
- **logs 目錄/檔不存在**:視為「尚無日誌」,非錯誤。

## 測試

- 沿用專案 `test/*.test.js` + node 內建 `assert` 風格。
- API 純函式:任務彙整(四目錄合併 + 狀態判定)、room 名稱翻譯、日誌 fallback 選擇、heartbeat 新鮮度判定。
- worker:擴充 `test/workerCore.test.js`,涵蓋 `pending → processing → done/failed` 流轉與 `pollOnce` 略過 `processing/`。

## 安全考量

- 儀表板僅綁 `127.0.0.1`,不對外、無需登入。
- `storage/`(含 rooms.json、heartbeat)、`queue/`、`output/` 已在 `.gitignore`。
- 輸出含解密訊息,API 回應內容視為機密,不另存快取。

## 不在範圍(未來)

- 從 UI 重跑失敗任務(requeue `failed → pending`)。
- 並發 executor、任務逾時控制。
- 真正的 executor 日誌格式(屆時對接 `queue/logs/<task>.log` 約定)。
- dev 監聽訊息區於正式上線時移除。
