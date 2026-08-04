# 驗收提交並推送設計

## 目標

按下 Dashboard 驗收按鈕後，目標專案不只提交代碼，也必須依自身規範推送代碼。

## 使用者介面

- 按鈕文字改為「驗收並推送」，避免文字過長。
- 驗收事件與 Dashboard 顯示的通知內容改為「提交代碼並推送」。

## 執行行為

- element-bot 仍先暫時把目標專案的 local `user.name` 設為驗收人公司 ID。
- 送給 Codex 的提示詞明確要求依目標專案的 `AGENTS.md`、instructions、skills 與既有流程產生 commit message、提交代碼並推送。
- element-bot 不自行執行 add、commit 或 push，也不檢查是否真的提交或推送成功。
- Codex 結束、失敗或逾時後，element-bot 仍還原原本的 local `user.name`。

## 相容性與測試

- 新建立的驗收事件固定使用「提交代碼並推送」；舊事件維持既有相容性處理，不修改已保存資料。
- 更新驗收事件、提示詞、Dashboard 按鈕與背景日誌的測試。
- 完整執行 `npm test`、`npm run test:codex-smoke` 與 `git diff --check`。
