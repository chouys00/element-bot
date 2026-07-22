# element-bot

即時監聽 Element/Matrix 上指定(可複數)加密聊天室的新訊息,解密後逐則寫入 `output/messages.jsonl`,供後續 AI agent 分析。

下游資料格式說明見 [AGENT_CONTEXT.md](./AGENT_CONTEXT.md);設計與計畫見 [docs/superpowers/](./docs/superpowers/)。

## 運作方式

每次啟動會用帳密登入「一個全新裝置」+ 記憶體版 Rust crypto,再用 Secure Backup recovery key:
1. cross-sign 自我驗證本裝置,
2. 載入並啟用 key backup(SDK 之後持續從伺服器備份下載房間金鑰)。

如此即可在「只把金鑰分享給已驗證裝置」的環境下解密訊息。crypto 不落地;舊的同名裝置會在登入時自動清除。

## 需求
- Node.js ≥ 22
- 一個 Matrix 帳號,且已設定 Secure Backup(有 recovery key)

## 安裝
```bash
npm install
```

## 設定
複製 `.env.example` 為 `.env`,填入:
- `MATRIX_HOMESERVER`、`MATRIX_USER_ID`
- `MATRIX_PASSWORD`(每次啟動的新裝置登入用)
- `MATRIX_RECOVERY_KEY`(Secure Backup 還原金鑰)
- `MATRIX_ROOM_IDS`(逗號分隔,支援複數)

`.env` 已被 `.gitignore` 排除,切勿提交。

## 啟動
```bash
npm start
```
啟動後到目標房間發一則新訊息,`output/messages.jsonl` 應新增一行解密後的明文。Ctrl+C 結束。

## Dashboard 驗收後發布

`skill-dispatch` 規則須設定 `target_branch`；舊規則缺少此欄位時會顯示設定錯誤並停止觸發。初始 Codex 由目標專案依自身規則建立 `queue/work/<task_id>/workspace` 專屬 Git worktree，只修改與驗證，不會 commit 或 push。完成後第一次按 Dashboard「驗收」時輸入公司 ID（例如 `patrick.zyx`），worker 才會回到同一 worktree 通知專案 commit 並 push 到指定分支。

公司 ID 保存在瀏覽器 `localStorage`，右上角唯讀顯示並可更換；格式為兩段英文字母以一個 `.` 分隔。這是可信內網署名，不是身分驗證。Dashboard 會顯示待驗收、提交中、已發布、發布失敗或發布結果未知；失敗／未知可重試發布，沿用原核准資料，不需要第二次驗收。

## 測試
```bash
npm test
```

## 疑難排解
- `cross-signing ready = false`:確認 recovery key 正確、帳號已設定 Secure Backup。
- `key backup 還原: 匯入 0`:帳號可能未啟用 key backup;稍候數秒讓其他端認得本裝置已驗證後再發訊息。
- 啟動印出 `解密失敗（等待金鑰）`:金鑰尚未到位,通常稍後會由 backup 下載後自動重新解密並擷取。
