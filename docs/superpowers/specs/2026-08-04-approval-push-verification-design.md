# 驗收後推送狀態與 Git 驗證設計

## 目標

Dashboard 驗收後不再立刻把任務視為完成。Codex 仍負責 commit 與 push；element-bot 只用唯讀 Git 證據確認驗收當下的遠端分支是否指向本次 commit。

## 狀態與資料

- 流程為「待驗收 → 等待推送 → 推送中 → 已完成」。
- 沒有新 commit、遠端不一致或目的地不明為「推送失敗」；遠端連續逾時或證據不足為「推送結果未知」。
- 驗收事件新增 `publish.status`：`pending | processing | success | failed | unknown`。
- 第一次處理保存 `before_head`、`remote`、`branch`；成功再保存 `commit_id`、第一行 `commit_subject`、`committer_name` 與 `finished_at`，失敗或未知保存簡短 `error`。
- 舊事件不補查遠端，維持原狀並顯示「舊資料未記錄推送結果」。

## Codex 對話續接

- 真正修改專案的 `execute` 任務不再使用 `--ephemeral`，改以 `--json` 讀取 `thread.started.thread_id`，並把精確 session ID 保存於任務工作資料。
- Dashboard 建立新式驗收事件時必須取得該 session ID，並一併保存。缺少 session ID 的舊任務不得另開 Codex 對話猜測提交內容；API 應明確拒絕並提示重新執行任務。
- 驗收與人工重試一律執行 `codex exec resume <SESSION_ID>`，只接受事件內保存的精確 ID，不得使用 `--last`，避免同專案或不同專案的並行任務接錯對話。
- 驗收與重試也不使用 `--ephemeral`，讓提交、推送結果及失敗原因繼續寫回同一 session。
- `judge`、`probe` 等不修改專案、也不需要後續驗收的內部 Codex 執行維持 `--ephemeral`。
- runner 必須從 JSONL 事件取得最後一則 agent message 作為原有結構化輸出，並驗證 resume 回報的 thread ID 與要求的 session ID 相同。無 session ID、ID 不一致或 JSONL 不完整都應停止，不能退回新對話。

## Session 保存與清理

- 推送成功或任務人工關閉後保留 session 7 天；保存期限分別從 `publish.finished_at` 或 `closure.closed_at` 起算。
- `pending`、`processing`、`failed`、`unknown` 及尚未驗收的任務不進入清理期限，因為仍可能需要原對話完成驗收或人工重試。
- 由既有 element-bot worker 在啟動時檢查一次，之後最多每 24 小時檢查一次，不新增常駐程序或持續監聽。
- 清理只掃描 element-bot 自己寫入的 `queue/work/<task_id>/codex-session.json`，並交叉確認 task ID、精確 UUID、驗收或關閉事件及 7 天期限；不得依 Codex 目錄、檔案時間或 `--last` 猜測目標。
- 任務中斷或人工重跑產生新 session 時，metadata 以目前 ID 供驗收，並在 `superseded_sessions` 保留舊 ID；進入清理期限後逐一刪除，已成功的 ID 立即記錄，避免中斷後重複處理或形成孤兒資料。
- 實際刪除由 `src/codexRunner.js` 啟動官方 app-server，完成初始化後呼叫 `thread/delete`，不啟動模型。其他模組只能要求 runner 刪除已驗證的 ID，不得自行建構或啟動 Codex CLI。
- 刪除成功後在 session metadata 記錄 `deleted_at`，避免重複執行；刪除失敗只記錄簡短錯誤並等待下次週期重試，不得改變任務或推送狀態。若 Codex 已刪除 rollout 內容、但自己的索引資料庫清理失敗，另記 `delete_warning`，視為內容已刪除，不直接修改 Codex 資料夾或資料庫。
- `codex archive` 不視為釋放空間；清理採永久刪除。舊任務、沒有 session metadata、session ID 不一致或證據不足時一律跳過。
- 每日清理水位保存在 queue，worker 重啟仍受 24 小時限制；人工重新開啟與 session 清理共用跨程序任務鎖，清理進行中回報稍後重試，不容許同時移除 closure。

## Git 驗證

1. 先保存本機 HEAD。驗證目的地優先使用目前分支 upstream；沒有 upstream 時，只有一個 remote 才使用該 remote 與 `target_branch`；多個 remote 時直接失敗。
2. Codex 最長執行時間維持 30 分鐘，並依目標專案規範完成 commit 與 push。
3. Codex 結束後讀取實際 HEAD、標題與 Committer，再以非互動式 `git ls-remote --heads` 比對遠端分支。
4. 遠端查詢最多三次，延遲為立即、2 秒、5 秒，每次約 3 秒逾時，且設定 `GIT_TERMINAL_PROMPT=0`。
5. 遠端等於本機新 HEAD 即成功，即使 Codex CLI 回報失敗也一樣；Committer 與驗收人不同只顯示身分警告。

驗證只證明當下遠端分支位置，不持續監聽之後的變化。element-bot 不執行 add、commit、push、fetch 或 pull；唯一 Git 寫入仍是暫時設定與還原 local `user.name`。

## 重試、重啟與排程

- failed 與 unknown 提供人工「重試提交／推送」與「設為已關閉」。不自動重跑 Codex。
- 重試沿用原驗收人與第一次的 `before_head`，先查遠端；已成功就直接完成，否則才提示 Codex 沿用既有 commit，避免重複提交。
- worker 重啟先還原 local `user.name`，再依 Git 證據決定 success、failed 或 unknown，不重複通知。
- 同一 `project_path` 有未關閉的 pending、processing、failed 或 unknown 推送時，暫停該專案新任務；其他專案不受影響。worker 每輪先處理驗收事件，再處理新任務。
- 新增 `POST /api/tasks/:id/retry-approval`，只接受未關閉的 failed 或 unknown 新式驗收事件。

## Dashboard

詳情顯示推送結果、驗收人、短 commit ID 與第一行標題、驗證的 remote／branch 及完成時間。實際 Committer 不符時顯示警告。failed 與 unknown 顯示錯誤、手動重試與關閉操作。
