# 顯示任務 ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任務詳情與 Matrix 任務通知顯示現有完整任務 ID。

**Architecture:** Dashboard 直接使用 API 已提供的 `task.id`；worker 寫通知檔時加入現有 `id`，通知格式化時輸出該欄位。不新增 ID 生成或查詢邏輯。

**Tech Stack:** Node.js 22、CommonJS、原生 HTML/JavaScript、原生 `assert` 測試。

## Global Constraints

- 任務列表不新增 ID 欄位。
- 不改變現有 ID。
- 不納入既有 `package-lock.json` 改動。

---

### Task 1: 新增失敗測試

- [ ] Dashboard 測試要求詳情模板包含任務 ID。
- [ ] 通知測試要求 payload 與文字包含任務 ID。
- [ ] 執行測試確認失敗。

### Task 2: 最小實作

- [ ] Dashboard 詳情加入完整 `t.id`。
- [ ] 通知 payload 加入 `id`，格式文字加入任務 ID 行。
- [ ] 執行局部測試確認通過。

### Task 3: 驗證與重啟

- [ ] 執行 `npm test`、`npm run test:codex-smoke`、`git diff --check`。
- [ ] 只提交本次檔案。
- [ ] queue 空閒後重啟 bot、worker、dashboard。
