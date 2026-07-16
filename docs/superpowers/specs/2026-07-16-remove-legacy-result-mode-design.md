# 移除 legacy 任務結果模式

## 目的

Element-bot 現行只使用通用的 Codex 任務結果格式：`status` 與完整 `output`。移除已停用的 legacy 詳細格式，避免正式程式、Dashboard 與測試持續維護兩套結果流程。

## 實作範圍

- `taskResult` 只保留 generic schema、解析、驗證與 queue 狀態對應。
- executor 固定使用 generic schema，不再讀取 `TASK_RESULT_MODE`，也不再保存 legacy 專用的起始 Git HEAD。
- 移除只服務 legacy 的 Git 偵測與外部 verify 函式。
- `taskDefs` 只保留通用分派實際使用的欄位；generic 提示詞內容維持不變。
- Dashboard 固定顯示 Codex 完整輸出，移除 legacy 詳細欄位的顯示分支。
- 通知仍從任務結果的 `output` 取得完整說明。
- `.env.example` 與現行遷移文件改為只描述 generic；Git 歷史與既有歷史設計文件保留，不刪除。

## 不在範圍內

- 不修改 Codex 提示詞的任務判斷邏輯。
- 不修改規則、queue 資料、目標專案或目標專案的 skills。
- 不改變 `success`、`failed`、`blocked`、`partial` 對應的 queue 狀態。
- 不整理與結果雙軌無關的既有模組。

## 驗證

- 先把測試改為只接受 generic，確認舊程式會失敗，再做最小實作。
- 驗證結果解析、executor、Dashboard、通知與整合流程。
- 執行 `npm test`、`npm run test:codex-smoke`、`git diff --check`。
- 確認只有 `src/codexRunner.js` 會啟動 agent CLI。

## 回復方式

需要恢復 legacy 時，從本次整理前的 Git 提交還原相關檔案；不在現行 runtime 保留雙軌開關。
