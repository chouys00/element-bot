# 修正斷點續跑狀態遺失 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 確保 worker 重啟後仍保留任務原本的 queue 狀態，且空 executor 結果不會被誤判為完成。

**Architecture:** `agentExecutor` 在步驟全部略過時，重新呼叫既有 `summarize` handler 讀取 `task-result.json`。`workerCore` 僅接受明確且合法的 `queueStatus`，沒有結果時走既有 failed 處理。

**Tech Stack:** Node.js 22、CommonJS、原生 `assert` 測試。

## Global Constraints

- 不修改四種結果狀態的定義。
- 不修改目標專案或 skills。
- 先建立失敗測試，再寫最小修正。

---

### Task 1: 還原續跑任務結果

**Files:**
- Modify: `test/executorIntegration.test.js`
- Modify: `src/executors/agentExecutor.js`

**Interfaces:**
- Consumes: `handlers.summarize({ workDir, task, emit, logger, shared })`
- Produces: `agentExecutor()` 在所有步驟已完成時仍回傳保存的 summary。

- [ ] 新增四步驟均為 `ok`、`task-result.json` 為 `blocked` 的續跑測試。
- [ ] 執行 `node test/executorIntegration.test.js`，確認回傳值為 `null` 而失敗。
- [ ] 在迴圈結束後，若沒有 summary，呼叫 `handlers.summarize()` 還原結果。
- [ ] 重跑測試，確認回傳 `queueStatus: blocked`。

### Task 2: 禁止空結果默認完成

**Files:**
- Modify: `test/workerCore.test.js`
- Modify: `src/workerCore.js`

**Interfaces:**
- Consumes: `executor()` 回傳的 `{ queueStatus }`
- Produces: 空結果或缺少 `queueStatus` 時任務進入 `failed/`。

- [ ] 新增 executor 回傳 `null` 的測試，預期 `failed` 且檔案位於 `failed/`。
- [ ] 執行 `node test/workerCore.test.js`，確認目前錯誤回傳 `done`。
- [ ] 移除 `queueStatus` 的 `done` 預設值，缺少狀態時拋出明確錯誤。
- [ ] 重跑測試，確認通過。

### Task 3: 完整驗證與重啟

**Files:**
- Verify: 上述程式與測試。

- [ ] 執行 `npm test`。
- [ ] 執行 `npm run test:codex-smoke`。
- [ ] 執行 `git diff --check` 並確認 CLI 啟動邊界。
- [ ] 只提交本次修正檔案，不包含既有 `package-lock.json` 改動。
- [ ] 確認無 pending／processing 任務後重啟服務並驗證 Dashboard。
