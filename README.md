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

`skill-dispatch` 規則必須設定 `project_path` 與 `target_branch`。worker 每輪只看排序後第一筆 pending 任務，並在啟動 Codex 前做唯讀 Git 檢查：

- `project_path` 必須存在且是 Git working tree。
- 目前分支必須等於 `target_branch`。
- `git status --porcelain -- .` 必須沒有未提交變更。

工作樹有修改、分支不符或為 detached HEAD 時，任務會保留在 pending，不會啟動 Codex，也不會增加執行次數。路徑或 Git repository 無效時才會移入 blocked 並顯示原因。已開始過且有 checkpoint 的中斷任務會略過新任務閘門，繼續原本的修改。

通過檢查後，Codex 直接在 `project_path` 修改與驗證，不會複製專案或建立 Task worktree；Dashboard 人工驗收前明確禁止 commit 與 push。因此同一時間只會進行一項修改，新任務會等專案重新回到乾淨狀態後再開始。

完成後第一次按 Dashboard「驗收」時輸入公司 ID（例如 `patrick.zyx`），任務會立即顯示「已完成」，同時建立內容固定為「提交代碼」的通知事件。worker 會先保存該 repository 原本的 local `user.name`，暫時執行 `git config --local user.name <公司 ID>`，再把通知送到同一個 `project_path`；後續 commit message、commit 與 push 仍由目標專案依自己的規則處理。

Codex 成功、失敗或逾時後，worker 都會恢復原本的 local `user.name`；原本未設定 local 值時會移除臨時值，重新繼承裝置的 global 設定。worker 重啟也會先補做還原；若補還原失敗，會保存 failed 狀態並停止啟動，避免用殘留名稱處理後續任務。`user.email` 不會改動。element-bot 不等待或判定 commit、push 等後續結果，也不自動重送失敗或中斷的通知；通知狀態不會讓任務退回待驗收。公司 ID 保存在瀏覽器 `localStorage`，右上角唯讀顯示並可更換；格式為兩段英文字母以一個 `.` 分隔。這是可信內網署名，不是身分驗證。

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
