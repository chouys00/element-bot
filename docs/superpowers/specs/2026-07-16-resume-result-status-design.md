# 修正斷點續跑狀態遺失

## 問題

任務已完成所有 executor 步驟後，如果 worker 在搬移 queue 檔案前重啟，下一次執行會略過所有步驟。此時 `agentExecutor` 沒有重新取得先前的 summary，回傳 `null`；`workerCore` 又把空結果預設為 `done`，導致原本的 `blocked`、`failed` 或 `review` 被誤報為完成。

## 設計

- `agentExecutor` 在所有步驟已略過、沒有本次 summary 時，從 `work/<id>/task-result.json` 重新產生 summary。
- 結果還原沿用 `defaultHandlers.summarize`，不另寫第二套解析邏輯。
- `workerCore` 要求 executor 必須回傳合法 `queueStatus`；空結果不再預設為 `done`，而是進入既有失敗處理。
- 不變更 `success`、`failed`、`blocked`、`partial` 的定義。

## 驗證

- 模擬四步驟均為 `ok` 且保存結果為 `blocked`，確認續跑後仍移入 `blocked/`。
- 模擬 executor 回傳空結果，確認任務移入 `failed/`。
- 執行完整測試、真實 Codex smoke test與 `git diff --check`。
