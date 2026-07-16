# 移除 Dashboard 開啟專案功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整移除 Dashboard 遠端開啟公共電腦專案資料夾的功能。

**Architecture:** 前端不產生開啟按鈕，後端不提供 open API；executor 不再輸出 `openPath`，task definition 不再維護路徑白名單。專案路徑仍由任務資料顯示。

**Tech Stack:** Node.js 22、CommonJS、原生 Dashboard HTML/JavaScript、原生 `assert` 測試。

## Global Constraints

- 不修改任務派發、結果狀態或專案路徑文字顯示。
- 不修改目標專案或 skills。
- 不納入既有 `package-lock.json` 改動。

---

### Task 1: 用測試封鎖所有開啟入口

**Files:**
- Modify: `test/dashboardServer.test.js`
- Modify: `test/defaultHandlers.test.js`
- Modify: `test/taskDefs.test.js`

- [ ] 斷言 Dashboard HTML 沒有「開啟專案」與 open request。
- [ ] 斷言 open API 回傳 404。
- [ ] 斷言 summary 沒有 `openPath`，taskDefs 不輸出 `PROJECT_ROOTS`。
- [ ] 執行測試確認因現行功能仍存在而失敗。

### Task 2: 移除正式程式

**Files:**
- Modify: `src/dashboard/public/index.html`
- Modify: `src/dashboard/server.js`
- Modify: `src/executors/defaultHandlers.js`
- Modify: `src/taskDefs.js`

- [ ] 移除按鈕、點擊處理與 open API。
- [ ] 移除 `openPath` 與 `PROJECT_ROOTS`。
- [ ] 執行局部測試確認通過。

### Task 3: 完整驗證與提交

- [ ] 執行 `npm test`。
- [ ] 執行 `npm run test:codex-smoke`。
- [ ] 執行 `git diff --check` 並確認 runtime CLI 邊界。
- [ ] 只提交本次功能相關檔案。
