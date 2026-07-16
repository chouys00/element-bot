# 縮短顯示用任務編號 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將 Dashboard 與通知顯示的內部任務 ID 轉成簡短且可反查的任務編號。

**Architecture:** 新增純函式 `formatTaskNumber(id)`，由 Dashboard aggregate 與通知共用。內部 `id` 保留，另提供 `task_number` 作顯示。

**Tech Stack:** Node.js 22、CommonJS、原生 `assert` 測試。

## Global Constraints

- 內部 ID、queue 檔名、API 與日誌索引不變。
- 固定使用 UTC+8。
- 無法辨識的 ID 原樣顯示。
- 不納入既有 `package-lock.json` 改動。

---

### Task 1: 任務編號轉換函式

- [ ] 新增測試，要求標準 ID 轉成 `20260716-114946-q3fnoi`，舊 ID 原樣回傳。
- [ ] 執行測試確認函式不存在而失敗。
- [ ] 新增 `src/taskNumber.js` 最小實作。
- [ ] 執行測試確認通過。

### Task 2: Dashboard 與通知套用

- [ ] 更新 aggregate、Dashboard 與通知測試，要求使用 `task_number`。
- [ ] 執行測試確認目前仍顯示完整 ID。
- [ ] aggregate 與通知 payload 加入 `task_number`，畫面與通知顯示該欄位。
- [ ] 執行局部測試確認通過。

### Task 3: 完整驗證與重啟

- [ ] 執行 `npm test`、`npm run test:codex-smoke`、`git diff --check`。
- [ ] 只提交本次檔案。
- [ ] queue 空閒後重啟 bot、worker、dashboard。
