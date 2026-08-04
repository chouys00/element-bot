# element-bot

即時監聽 Element/Matrix 上指定（可複數）加密聊天室的新訊息，解密後逐則寫入 `output/messages.jsonl`，供後續 AI agent 分析。

下游資料格式說明見 [AGENT_CONTEXT.md](./AGENT_CONTEXT.md)；設計與計畫見 [docs/superpowers/](./docs/superpowers/)。

## 運作方式

每次啟動會用帳密登入「一個全新裝置」與記憶體版 Rust crypto，再用 Secure Backup recovery key：

1. cross-sign 自我驗證本裝置。
2. 載入並啟用 key backup，持續從伺服器下載房間金鑰。

如此即可在「只把金鑰分享給已驗證裝置」的環境下解密訊息。crypto 不落地；舊的同名裝置會在登入時自動清除。

## 需求

- Node.js ≥ 22
- 一個 Matrix 帳號，且已設定 Secure Backup（有 recovery key）

## 安裝

```bash
npm install
```

## 設定

複製 `.env.example` 為 `.env`，填入：

- `MATRIX_HOMESERVER`、`MATRIX_USER_ID`
- `MATRIX_PASSWORD`（每次啟動的新裝置登入用）
- `MATRIX_RECOVERY_KEY`（Secure Backup 還原金鑰）
- `MATRIX_ROOM_IDS`（逗號分隔，支援複數）

`.env` 已被 `.gitignore` 排除，切勿提交。

## 啟動

```bash
npm start
```

啟動後到目標房間發一則新訊息，`output/messages.jsonl` 應新增一行解密後的明文。Ctrl+C 結束。

## 任務執行與 Dashboard 驗收

`skill-dispatch` 規則必須設定 `project_path` 與 `target_branch`。worker 每輪最多執行一筆 pending 任務；若前面的任務正在等待同專案推送結案，會繼續尋找其他可執行專案。啟動 Codex 前會做唯讀 Git 檢查：

- `project_path` 必須存在且是 Git working tree。
- 目前分支必須等於 `target_branch`。
- `git status --porcelain -- .` 必須沒有未提交變更。

工作樹有修改、分支不符或為 detached HEAD 時，任務會保留在 pending，不會啟動 Codex，也不會增加執行次數。路徑或 Git repository 無效時才會移入 blocked 並顯示原因。已開始過且有 checkpoint 的中斷任務會略過新任務閘門，繼續原本的修改。

通過檢查後，Codex 直接在 `project_path` 修改與驗證，不會複製專案或建立 Task worktree；Dashboard 人工驗收前明確禁止 commit 與 push。這次 execute 的精確 Codex session ID 會保存在任務工作資料，因此同一時間只會進行一項修改，新任務會等專案重新回到乾淨狀態後再開始。

完成後第一次按 Dashboard「驗收並推送」時輸入公司 ID（例如 `patrick.zyx`），任務會依序顯示「等待推送」與「推送中」。worker 每輪先處理驗收事件，再處理新任務；同一 `project_path` 有尚未結案的等待、進行中、失敗或未知推送時，該專案的新任務暫停，其他專案不受影響。

worker 會在 Codex 前保存本機 HEAD，優先使用目前分支的 upstream；沒有 upstream 時，只有一個 remote 才使用該 remote 與 `target_branch`，多個 remote 則直接回報失敗。接著暫時執行 `git config --local user.name <公司 ID>`，以精確 session ID 續接原本執行修改的 Codex 對話，讓它依目標專案規則完成 commit 與 push。驗收與人工重試不使用 `--last`，也不會另開對話猜測提交內容。Codex 結束後，element-bot 只以唯讀 `git ls-remote` 比對遠端分支與本機新 HEAD，不會自行執行 add、commit 或 push，也不會持續監聽遠端。

遠端與本機新 HEAD 一致才顯示「已完成」，並保存 commit 短 ID、第一行標題、驗證的 remote／branch 與完成時間；實際 Committer 與驗收人不同時另顯示警告。沒有新 commit、遠端不一致或目的地不明會顯示「推送失敗」；遠端連續逾時或證據不足會顯示「推送結果未知」。遠端查詢最多三次，延遲為立即、2 秒、5 秒，每次約 3 秒逾時。

失敗與未知不會自動重跑 Codex，可在 Dashboard 選擇「重試提交／推送」或「設為已關閉」。手動重試會沿用原驗收人與第一次驗收前 HEAD，先重新查遠端；若其實已推送成功就直接完成，否則才再次通知 Codex 沿用既有 commit，避免重複提交。Codex 成功、失敗、逾時或 worker 重啟後，worker 都會先恢復原本的 local `user.name`；`user.email` 不變。舊驗收事件不補查遠端，Dashboard 會標示「舊資料未記錄推送結果」。

execute、驗收與重試期間會保存同一個 Codex session，不使用 `--ephemeral`；內部 `judge` 與 `probe` 維持 ephemeral。若任務中斷或人工重跑而產生新 session，舊 ID 也會保留在任務 metadata，避免留下無法追蹤的對話。推送成功或人工關閉後保留所有相關 session 7 天，再由既有 worker 最多每 24 小時檢查一次，透過 Codex 官方 `thread/delete` 只刪除 element-bot 自己記錄的精確 UUID；清理水位會保存在 queue，重啟不會提早重跑。重新開啟與清理使用同一把任務鎖，避免清理途中恢復任務；保存期限過後 session 已刪除的任務不能再重新開啟、驗收或重試。等待驗收、失敗、未知或證據不足時不會刪除；清理不啟動模型，失敗也不影響任務狀態。element-bot 不會直接刪除 Codex 檔案或修改其資料庫；若 Codex 已移除對話內容但索引清理失敗，metadata 會跨清理重試保留警告。

公司 ID 保存在瀏覽器 `localStorage`，右上角唯讀顯示並可更換；格式為兩段英文字母以一個 `.` 分隔。它代表驗收時暫設的 Git `user.name`，不是 GitHub／GitLab 推送帳號，也不是身分驗證。

## 測試

```bash
npm test
npm run test:codex-smoke
```

## 疑難排解

- `cross-signing ready = false`：確認 recovery key 正確、帳號已設定 Secure Backup。
- `key backup 還原: 匯入 0`：帳號可能未啟用 key backup；稍候數秒讓其他端認得本裝置已驗證後再發訊息。
- 啟動印出 `解密失敗（等待金鑰）`：金鑰尚未到位，通常稍後會由 backup 下載後自動重新解密並擷取。
- 任務一直停在 pending：先到 `project_path` 確認目前分支與 `target_branch` 相同，再處理 `git status --porcelain -- .` 顯示的未提交變更。
