# 移除 legacy 任務結果模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 legacy 結果格式及其衍生分支，讓 element-bot 只保留現行 generic Codex 任務結果流程。

**Architecture:** 任務結果固定為 `{ status, output }`，executor 直接把唯一 schema 傳給 Codex，Dashboard 與通知直接呈現 `output`。歷史 Git 與設計文件保留，但現行 runtime 不提供模式切換。

**Tech Stack:** Node.js 22、CommonJS、Codex CLI、原生 `assert` 測試。

## Global Constraints

- 不修改 generic 提示詞的內容與任務判斷行為。
- 不修改規則、queue 資料、目標專案或目標專案的 skills。
- 保留 `success`、`failed`、`blocked`、`partial` 的 queue 狀態對應。
- 行為變更遵守 TDD；Git commit message 使用繁體中文。

---

### Task 1: 結果契約只保留 generic

**Files:**
- Modify: `test/taskResult.test.js`
- Modify: `src/executors/taskResult.js`

**Interfaces:**
- Produces: `TASK_RESULT_SCHEMA`、`parseTaskResult(stdout)`、`validateTaskResult(result)`、`queueStatus(status)`。

- [ ] **Step 1: 將測試改為只接受 `{ status, output }`，並斷言 legacy exports 不存在**
- [ ] **Step 2: 執行 `node test/taskResult.test.js`，確認舊雙軌程式因多餘 exports 或 legacy 自動辨識而失敗**
- [ ] **Step 3: 刪除 legacy schema、模式選擇、自動辨識及詳細欄位驗證，只保留唯一 schema**
- [ ] **Step 4: 執行 `node test/taskResult.test.js`，確認通過**

### Task 2: Executor 與任務定義固定走 generic

**Files:**
- Modify: `test/defaultHandlers.test.js`
- Modify: `test/executorIntegration.test.js`
- Modify: `test/taskDefs.test.js`
- Modify: `src/executors/defaultHandlers.js`
- Modify: `src/executors/ops.js`
- Modify: `src/taskDefs.js`

**Interfaces:**
- Consumes: Task 1 的唯一 `TASK_RESULT_SCHEMA` 與結果解析函式。
- Produces: `ops.runCodex(prompt, projectDir)` 固定使用唯一 schema；`taskDefs.prompt(task)` 固定產生現行 generic 提示詞。

- [ ] **Step 1: 移除測試中的 `resultMode` 與 legacy 情境，新增斷言確認 ops 不再輸出 Git／verify 舊函式，task definition 不再包含 `verifyArgs`、`needsReview`**
- [ ] **Step 2: 執行三個單元測試，確認因正式程式仍有 legacy 與舊 exports 而失敗**
- [ ] **Step 3: 簡化 handler 的 prepare／ai_run／summarize，移除 mode、base HEAD 與 legacy output 分支**
- [ ] **Step 4: 將 ops 簡化為只包裝 Codex execute；刪除 Git／verify 舊函式**
- [ ] **Step 5: 將 `taskDefs.prompt` 固定為目前 generic 提示詞，刪除未使用的 definition 欄位**
- [ ] **Step 6: 執行三個單元測試與 `node test/codexSmoke.test.js` 的非正式替代檢查所涵蓋的 schema 單元測試，確認通過**

### Task 3: Dashboard、通知、設定與文件移除 legacy 分支

**Files:**
- Modify: `test/dashboardServer.test.js`
- Modify: `test/notify.test.js`
- Modify: `test/runtimeMigration.test.js`
- Modify: `src/dashboard/public/index.html`
- Modify: `src/notify.js`
- Modify: `.env.example`
- Modify: `docs/codex-runtime-migration.md`

**Interfaces:**
- Consumes: summary 的唯一 `output` 欄位與 `ai_output` log。
- Produces: Dashboard 固定顯示「執行輸出 (Codex)」；通知固定取最後一筆 `output`。

- [ ] **Step 1: 更新測試，斷言頁面、通知與現行文件不含 legacy／`TASK_RESULT_MODE` 執行開關**
- [ ] **Step 2: 執行三個測試，確認舊分支仍存在而失敗**
- [ ] **Step 3: 刪除 Dashboard legacy 詳細結果 HTML 與條件排列，固定顯示 Codex output**
- [ ] **Step 4: 通知只讀取 generic `output`；移除 `.env.example` 的模式開關並更新遷移文件**
- [ ] **Step 5: 執行三個測試，確認通過**

### Task 4: 完整驗證與提交

**Files:**
- Verify: 所有上述檔案

**Interfaces:**
- Consumes: Tasks 1–3 的完整 generic-only runtime。

- [ ] **Step 1: 執行 `npm test`，預期全部通過**
- [ ] **Step 2: 執行 `npm run test:codex-smoke`，預期真實 Codex generic no-op 測試通過且暫存 repository 無修改**
- [ ] **Step 3: 執行 `git diff --check`，預期無錯誤**
- [ ] **Step 4: 搜尋 agent CLI 啟動點，確認只有 `src/codexRunner.js`**
- [ ] **Step 5: 檢查 diff 僅包含核准範圍，使用繁體中文提交訊息提交**
