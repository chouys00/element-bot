# AGENT_CONTEXT — 給下游 AI agent 的資料說明

這份文件描述 `element-bot` 產出的資料，讓後續的 AI agent 能正確理解與消費。

## 這是什麼

`element-bot` 即時監聽公司 Element/Matrix 上指定聊天室的**新訊息**，將 E2EE 加密訊息**解密後**，逐則寫入一個 **JSONL** 檔。每則訊息一行，append-only（只新增、不修改既有行）。

- 輸出檔：`output/messages.jsonl`
- 編碼：UTF-8
- 範圍：**只有 bot 啟動之後送出的新訊息**；不含歷史訊息。
- 來源帳號：`@patrick.zyx:ims.opscloud.info` 的一個專屬監聽裝置。

## 每行的資料結構

每一行是一個獨立的 JSON 物件：

```json
{
  "event_id": "$abc123...",
  "room_id": "!jOuxmbWVxsEbbcByqa:ims.opscloud.info",
  "sender": "@alice:ims.opscloud.info",
  "origin_server_ts": 1718694123456,
  "type": "m.room.message",
  "msgtype": "m.text",
  "body": "明天的會議改到下午三點",
  "_received_at": "2026-06-18T10:30:00.000Z"
}
```

### 欄位說明

| 欄位 | 型別 | 意義 |
|---|---|---|
| `event_id` | string | Matrix 事件唯一 ID，可用來去重 |
| `room_id` | string | 訊息所屬聊天室 |
| `sender` | string | 發送者的 Matrix user ID |
| `origin_server_ts` | number | 伺服器端訊息時間（Unix 毫秒） |
| `type` | string | 一律為 `m.room.message` |
| `msgtype` | string | 訊息子型別：`m.text`、`m.notice`、`m.emote`、`m.image`、`m.file` 等 |
| `body` | string | **訊息明文內容**（已解密）。分析時主要看這個欄位 |
| `_received_at` | string | bot 接收並寫入的本機時間（ISO 8601） |

## 消費建議

- **逐行讀取**（JSONL，不是單一 JSON 陣列）；每行 `JSON.parse`。
- **以 `event_id` 去重**，避免重複處理。
- **以 `origin_server_ts` 排序**判斷時間先後。
- 目前只保證 `m.text` 類文字內容適合直接分析；媒體類的 `body` 只是檔名，沒有實際內容。
- 檔案會持續增長且 append-only；串流處理可只讀取新增的尾段。

## 相關檔案（v1.5+）

除了 `output/messages.jsonl`，系統還維護：

| 檔案 | 說明 |
|---|---|
| `config/rules.json` | 觸發規則（關鍵字 → 任務），由 Dashboard 編輯、bot 熱載入 |
| `storage/rooms-config.json` | 監聽房間清單；`.env` 的 `MATRIX_ROOM_IDS` 只在此檔不存在時作後備 |
| `storage/notify-config.json` | 任務完成通知設定 |
| `storage/rooms.json` | room_id → 房間名稱對照 |
| `queue/` | 任務佇列、checkpoint、執行 log 與 approval outbox |

Dashboard（`npm run dashboard`）提供任務監控、規則編輯與試跑介面。

## 任務執行、驗收與專案通知

`skill-dispatch` 規則必須設定 `project_path` 與 `target_branch`。worker 每輪只嘗試排序後第一筆 pending 任務。新任務啟動前，由專用模組執行唯讀 Git 檢查：

- 路徑存在且是 Git working tree。
- 目前分支等於 `target_branch`。
- `git status --porcelain -- .` 沒有未提交變更。

dirty、錯誤分支或 detached HEAD 會讓任務保留在 pending，不啟動 Codex且不增加 attempt；無效路徑或非 Git repository 會移入 blocked。已有 `prepare: ok` checkpoint 的中斷任務可略過起跑閘門，繼續自己先前留下的修改。

通過閘門後，Codex 直接以 `project_path` 為 cwd 修改與驗證，不建立 Task worktree，不在 Dashboard 驗收前 commit 或 push。完成一筆後，下一筆任務會等待專案重新乾淨。

驗收人公司 ID 由各瀏覽器保存於 `localStorage`，格式為兩段英文字母以一個 `.` 分隔，屬可信內網署名，不提供防偽或登入驗證。新驗收事件包含：

```json
{
  "task_id": "原始完整任務 ID",
  "project_path": "目標專案絕對路徑",
  "target_branch": "目標分支",
  "approved_by": "驗收人公司 ID",
  "approved_at": "伺服器產生的 ISO 8601 時間",
  "message": "提交代碼",
  "attempt": 0
}
```

按下「驗收」並成功建立事件後，Dashboard 立即把任務顯示為「已完成」，不等待通知處理結果。事件依狀態保存於 `queue/approvals/pending|processing|done|failed/`；`unknown` 只保留給既有歷史事件相容。worker 透過 Codex 在 `project_path` 送出「提交代碼」，讓目標專案依自己的 AGENTS.md、instructions、skills 與既有流程處理。

element-bot 只直接執行起跑用的唯讀 Git 查詢與這次通知，不檢查或追蹤目標專案是否 commit、push。Codex 呼叫正常結束即視為訊息已送達；啟動、逾時或 CLI 錯誤會把事件記為 `failed`，但任務仍維持已完成且不自動重送。worker 重啟時遇到中斷在 `processing` 的事件會直接結束，不重新傳送，以避免專案收到重複通知。既有含 `workspace_path` 的舊事件仍可讀取，但通知一律送到 `project_path`。

## 驗收連結（v1.7+）

任務專案若產生可供人員驗收的資源，可在 Codex 通用結果的 `output` 以獨立的「驗收連結」區塊宣告完整 `http://` 或 `https://` URL。例如：

```json
{
  "status": "success",
  "output": "已完成前端修改。\n\n驗收連結：\n- https://preview.intra.local/tasks/task-123/"
}
```

element-bot 只解析此區塊中每行 `- URL` 的連結，並在 Dashboard 任務詳情顯示「驗收連結」、在 Matrix 任務通知的摘要前列出 URL。其他未宣告 URL 不會出現在驗收欄位。它只轉交連結，不會啟動、檢查、停止或託管任務專案的 preview、截圖、錄影或 build 產物。

## 不在範圍內

- 不含加密媒體的實際內容（只有檔名）。
- 不含歷史訊息（裝置建立前的訊息）。
- 不含已編輯／撤回的關聯合併處理。
