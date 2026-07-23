# Dashboard Header 精簡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將 Dashboard Header 精簡為三項摘要，顯示 Matrix 登入帳號名稱，並把「驗收人」改稱「操作者」。

**Architecture:** Dashboard 從既有 `MATRIX_USER_ID` 取得 Matrix 身分，只透過 `/api/status` 回傳 localpart。前端保留完整任務狀態，但 Header 僅彙總成「執行中、待驗收、異常」。

**Tech Stack:** Node.js CommonJS、原生 HTTP server、HTML/CSS/JavaScript。

## Global Constraints

- Matrix 帳號 `@fe_bot:ims.opscloud.info` 顯示為 `fe_bot`。
- Header 固定顯示三項摘要，不移除任務列表的詳細狀態。
- 「操作者」仍使用既有 `localStorage` 公司 ID，approval payload 與 commit metadata 不變。
- 行為變更先寫失敗測試，再做最小實作。

---

### Task 1: Header 身分與狀態摘要

**Files:**
- Modify: `test/dashboardServer.test.js`
- Modify: `src/config.js`
- Modify: `src/dashboard/index.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/public/index.html`

**Interfaces:**
- Consumes: `MATRIX_USER_ID`
- Produces: `GET /api/status` 的 `matrix_account_name: string`

- [ ] **Step 1: Write the failing test**

在 `createServer()` 測試依賴加入 `matrixUserId: "@fe_bot:ims.opscloud.info"`，並驗證：

```js
ok("status 回傳 Matrix 帳號名稱", status.matrix_account_name === "fe_bot");
ok("dashboard 顯示 Matrix 帳號與操作者",
  htmlText.includes('id="matrixAccount"') &&
  htmlText.includes("操作者：") &&
  !htmlText.includes("驗收人："));
ok("dashboard Header 使用三項摘要",
  htmlText.includes("執行中") &&
  htmlText.includes("待驗收") &&
  htmlText.includes("異常") &&
  !htmlText.includes("<span>LLM 判斷中"));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/dashboardServer.test.js`

Expected: FAIL，因 `matrix_account_name` 與新 Header 尚不存在。

- [ ] **Step 3: Write minimal implementation**

`loadDashboardConfig()` 帶入：

```js
matrixUserId: process.env.MATRIX_USER_ID || "",
```

Dashboard server 將完整 Matrix ID 轉成 localpart：

```js
function matrixAccountName(userId) {
  const raw = String(userId || "").trim();
  const match = raw.match(/^@?([^:]+)(?::.*)?$/);
  return match ? match[1] : "";
}
```

`/api/status` 新增：

```js
matrix_account_name: matrixAccountName(matrixUserId),
```

前端 Header 顯示 `Matrix：fe_bot` 與 `操作者：patrick.zyx`，摘要計算為：

```js
const active = (c.judging || 0) + (c.pending || 0) + (c.processing || 0) + (c.publishing || 0);
const review = c.review || 0;
const issues = (c.blocked || 0) + (c.failed || 0) + (c.publish_failed || 0) + (c.publish_unknown || 0);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/dashboardServer.test.js`

Expected: PASS。

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm test
git diff --check
rg -n "child_process|spawn\\(|execFile\\(" src
```

Expected: 全部測試通過、diff 無空白錯誤，且只有 `src/codexRunner.js` 建構或啟動 Codex CLI。

- [ ] **Step 6: Commit**

```powershell
git add docs/superpowers/plans/2026-07-23-dashboard-header-summary.md test/dashboardServer.test.js src/config.js src/dashboard/index.js src/dashboard/server.js src/dashboard/public/index.html
git commit -m "調整：精簡 Dashboard Header 狀態"
```
