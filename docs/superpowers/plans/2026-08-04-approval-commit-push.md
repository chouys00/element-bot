# 驗收提交並推送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 驗收後明確要求目標專案提交代碼並推送，同時以簡短按鈕「驗收並推送」告知驗收人。

**Architecture:** 沿用既有 approval event 與 Codex runner，不在 element-bot 新增任何 Git push 呼叫。approval store 保存固定通知內容，approval executor 將提交與推送要求送給目標專案；Dashboard 與 worker 日誌同步更新文字。

**Tech Stack:** Node.js、CommonJS、內建 `assert` 測試、Codex CLI。

## Global Constraints

- element-bot 不得自行執行 add、commit 或 push，也不判定目標專案是否推送成功。
- 自動測試不得對任何真實 remote 推送。
- 真實推送驗證只能在 `D:\test\ftl-element-bot-acceptance` 執行。
- Git commit message 使用繁體中文。

---

### Task 1: 驗收事件與 Codex 提示詞

**Files:**
- Modify: `test/approvalStore.test.js`
- Modify: `test/approvalExecutor.test.js`
- Modify: `test/simpleApprovalFlow.test.js`
- Modify: `test/directProjectExecution.test.js`
- Modify: `src/approvalStore.js`
- Modify: `src/executors/approvalExecutor.js`

**Interfaces:**
- Consumes: `createApproval(queueDir, taskId, task, approvedBy, nowFn)` 與 `buildApprovalPrompt(event)`。
- Produces: 新事件的 `message` 固定為 `提交代碼並推送`，提示詞明確包含 commit 與 push 要求。

- [x] **Step 1: 先修改測試期待值**

```javascript
assert.strictEqual(created.event.message, "提交代碼並推送");
assert.ok(prompt.includes("通知內容：提交代碼並推送"));
assert.ok(prompt.includes("提交代碼並推送"));
```

- [x] **Step 2: 執行相關測試並確認因舊文字而失敗**

Run: `node test/approvalStore.test.js; node test/approvalExecutor.test.js; node test/simpleApprovalFlow.test.js; node test/directProjectExecution.test.js`

Expected: 至少一項 FAIL，實際值仍為「提交代碼」或提示詞沒有推送要求。

- [x] **Step 3: 修改最小實作**

```javascript
const APPROVAL_MESSAGE = "提交代碼並推送";
```

並將 `buildApprovalPrompt()` 的預設訊息與行為句更新為：

```text
請依目標專案本身的 AGENTS.md、instructions、skills 與既有流程產生 commit message、提交代碼並推送。
```

- [x] **Step 4: 重跑相關測試並確認通過**

Run: `node test/approvalStore.test.js; node test/approvalExecutor.test.js; node test/simpleApprovalFlow.test.js; node test/directProjectExecution.test.js`

Expected: PASS。

### Task 2: Dashboard 與背景日誌文字

**Files:**
- Modify: `test/dashboardServer.test.js`
- Modify: `test/approvalWorker.test.js`
- Modify: `src/dashboard/public/index.html`
- Modify: `src/approvalWorker.js`

**Interfaces:**
- Consumes: Dashboard 的 approval event 與 worker 完成狀態。
- Produces: 按鈕顯示「驗收並推送」，通知內容與日誌顯示「提交代碼並推送」。

- [x] **Step 1: 先修改 UI 與日誌測試**

```javascript
htmlText.includes('>✓ 驗收並推送</button>')
approval.message === "提交代碼並推送"
```

- [x] **Step 2: 執行測試並確認因舊文字而失敗**

Run: `node test/dashboardServer.test.js; node test/approvalWorker.test.js`

Expected: Dashboard 測試 FAIL，仍找到「驗收並提交代碼」或「提交代碼」。

- [x] **Step 3: 修改最小實作**

```html
<button data-act="approve" class="abtn">✓ 驗收並推送</button>
```

Dashboard 預設顯示與 worker 成功日誌一律改為「提交代碼並推送」。

- [x] **Step 4: 重跑測試並確認通過**

Run: `node test/dashboardServer.test.js; node test/approvalWorker.test.js`

Expected: PASS。

### Task 3: 完整驗證與限定 acceptance 測試

**Files:**
- Verify: `src/approvalStore.js`
- Verify: `src/executors/approvalExecutor.js`
- Verify: `src/dashboard/public/index.html`
- Verify: `src/approvalWorker.js`
- Verify only: `D:\test\ftl-element-bot-acceptance`

**Interfaces:**
- Consumes: 完整測試指令與 acceptance repository 的既有 remote。
- Produces: 沒有 element-bot 自行 push 入口的驗證結果，以及唯一真實推送測試的時間紀錄。

- [x] **Step 1: 執行完整單元測試**

Run: `npm test`

Expected: PASS；測試內不啟動 Codex，也不執行真實 remote push。

- [x] **Step 2: 檢查格式與 Git 邊界**

Run: `git diff --check`

Run: `rg -n "spawn|execFile|exec|push" src`

Expected: 除 `src/codexRunner.js` 與既有允許的 Git 身分模組外，沒有新增 CLI 啟動或 bot 自行 push 入口。

- [x] **Step 3: 在指定專案執行唯一真實推送驗證**

先確認 `D:\test\ftl-element-bot-acceptance` 的目前分支、remote、HEAD、工作樹及 local `user.name`；透過更新後的驗收流程要求 Codex commit 與 push。記錄按下驗收、commit 產生、remote branch 更新與名稱還原的時間。

Expected: remote branch 指向新 commit，Author／Committer 為驗收人，local `user.name` 已恢復。

- [x] **Step 4: 提交 element-bot 修改**

```bash
git add src test docs/superpowers/plans/2026-08-04-approval-commit-push.md
git commit -m "功能：驗收後提交並推送代碼"
```
