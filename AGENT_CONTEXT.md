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

`skill-dispatch` 規則必須設定 `project_path` 與 `target_branch`。worker 每輪最多執行一筆 pending 任務；等待中的專案會被略過，後方其他可執行專案仍可處理。新任務啟動前，由專用模組執行唯讀 Git 檢查：

- 路徑存在且是 Git working tree。
- 目前分支等於 `target_branch`。
- `git status --porcelain -- .` 沒有未提交變更。

dirty、錯誤分支或 detached HEAD 會讓任務保留在 pending，不啟動 Codex且不增加 attempt；無效路徑或非 Git repository 會移入 blocked。已有 `prepare: ok` checkpoint 的中斷任務可略過起跑閘門，繼續自己先前留下的修改。

通過閘門後，Codex 直接以 `project_path` 為 cwd 修改與驗證，不建立 Task worktree，不在 Dashboard 驗收前 commit 或 push。execute 任務會保存精確 Codex session ID；完成一筆後，下一筆任務會等待專案重新乾淨。

驗收人公司 ID 由各瀏覽器保存於 `localStorage`，格式為兩段英文字母以一個 `.` 分隔，屬可信內網署名，不提供防偽或登入驗證。新驗收事件包含：

```json
{
  "task_id": "原始完整任務 ID",
  "project_path": "目標專案絕對路徑",
  "target_branch": "目標分支",
  "approved_by": "驗收人公司 ID",
  "approved_at": "伺服器產生的 ISO 8601 時間",
  "message": "提交代碼並推送",
  "codex_session_id": "原始 execute 任務的精確 Codex session UUID",
  "attempt": 0,
  "publish": { "status": "pending" }
}
```

按下「驗收並推送」後，Dashboard 依序顯示「等待推送」與「推送中」，只有遠端驗證成功才顯示「已完成」。事件依狀態保存於 `queue/approvals/pending|processing|done|failed|unknown/`。worker 每輪先處理驗收事件；同一 `project_path` 有未關閉的 pending、processing、failed 或 unknown 驗收事件時，暫停該專案的新任務，其他專案照常處理。

第一次處理驗收時，worker 保存本機 HEAD 並決定驗證目的地：優先使用目前分支 upstream；沒有 upstream 且只有一個 remote 時使用該 remote 與 `target_branch`；多個 remote 時不猜測。worker 暫時設定 local `user.name` 為 `approved_by`，再以精確 `codex_session_id` 續接原本執行修改的 Codex 對話，要求目標專案依自己的規範 commit 與 push，最後恢復原值。驗收與重試不得使用 `--last` 或另開對話；`user.email` 不變。

Codex 結束後，以非互動式 `git ls-remote` 唯讀比對遠端分支與本機新 HEAD。遠端一致為 success；沒有新 commit、遠端不一致或目的地不明為 failed；三次遠端查詢都失敗或證據不足為 unknown。即使 Codex CLI 回報錯誤，遠端已是正確 commit 仍算 success。成功事件保存 `commit_id`、`commit_subject`、`committer_name`、`remote`、`branch` 與 `finished_at`；Committer 與驗收人不同只顯示警告，不改變推送判定。

failed 與 unknown 只接受人工呼叫 `POST /api/tasks/:id/retry-approval`。重試沿用原驗收人與第一次的 `before_head`，先查遠端；已成功則不啟動 Codex，尚未成功才要求 Codex 沿用既有 commit。也可將事件設為已關閉以解除專案暫停。舊驗收事件沒有 `publish` 時不補查遠端，沿用舊相容流程並在 Dashboard 標示「舊資料未記錄推送結果」。

element-bot 的 Git 寫入仍只有暫設與還原 local `user.name`；遠端驗證模組只能執行唯讀 commit／remote 查詢與 `ls-remote`，不得執行 add、commit、push、fetch 或 pull。worker 重啟會先還原身分，再依現有 Git 證據決定 success、failed 或 unknown，且不自動重跑 Codex。

execute、驗收與重試會保存在同一個 Codex session；`judge` 與 `probe` 等不需續接的內部執行仍使用 `--ephemeral`。任務中斷或人工重跑產生的新 session 會成為目前驗收目標，舊 ID 仍保存在 `superseded_sessions`。推送成功或任務人工關閉後，所有相關 session 保留 7 天供追查，之後由既有 worker 最多每 24 小時檢查一次，透過 runner 呼叫 Codex 官方 app-server 的 `thread/delete`；最後清理時間保存在 queue，worker 重啟不會提早重跑。重新開啟與清理共用跨程序任務鎖；session 已刪除後，reopen、approve 與 retry 都回報衝突。等待驗收、failed、unknown、缺少 metadata、ID 不一致與舊資料一律不刪除；清理失敗只留下錯誤供下次重試，不影響任務狀態。若 rollout 內容已刪除但 Codex 自己的索引清理失敗，警告會跨清理重試保存，不直接修改 Codex 的資料夾或資料庫。

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
