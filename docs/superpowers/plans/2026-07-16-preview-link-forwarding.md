# Preview Link Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓任務專案放在 Codex output 的 HTTP(S) 驗收 URL，安全出現在 Dashboard 與 Matrix 通知。

**Architecture:** 新增純函式 URL 擷取模組，供 progress API 與通知共用。任務結果 schema、Codex runner、任務執行方式均不變；派發器僅轉交 URL。

**Tech Stack:** Node.js CommonJS、Node 內建 `assert`、既有 HTTP Dashboard、原生瀏覽器 JavaScript。

## Global Constraints

- `status + output` 是精確的通用結果契約，不新增 preview 專用欄位。
- 只接受 `http:` 與 `https:`；不可將 output 當 HTML 注入。
- TDD：先寫會失敗的測試，再寫最小實作。
- 完成前執行 `git diff --check`、`npm test`、`npm run test:codex-smoke`。

### Task 1: HTTP(S) URL 擷取模組

**Files:** Create `src/links.js`; Test `test/links.test.js`.

**Interface:** `extractHttpLinks(text): string[]` 依出現順序回傳去重且可解析的 HTTP(S) URL。

- [ ] 寫測試：正常 URL、重複 URL、`javascript:`／`file:`／`ftp:` 均不可回傳。
- [ ] 執行 `node test/links.test.js`，確認因缺少 `src/links.js` 失敗。
- [ ] 以 regex 找候選字串、`new URL()` 驗證 protocol、保留第一次出現的 URL，完成最小實作。
- [ ] 執行 `node test/links.test.js`，確認通過。
- [ ] Commit：`功能：擷取任務輸出中的驗收連結`。

### Task 2: Dashboard API 與相關連結區塊

**Files:** Modify `src/dashboard/aggregate.js`, `src/dashboard/public/index.html`; Test `test/aggregate.test.js`.

**Interface:** `parseProgress(queueDir, id)` 額外回傳 `links: string[]`；沒有 log 時回傳空陣列。

- [ ] 寫測試：含 output URL 的 progress 回傳唯一 URL 陣列。
- [ ] 執行 `node test/aggregate.test.js`，確認 `links` 尚不存在而失敗。
- [ ] 在 aggregate 匯入 `extractHttpLinks`，從 `aiOutput` 或 `summary.output` 產生 `links`；缺 log 的回傳值加入空陣列。
- [ ] 在 `renderDetail()` 將 `prog.links` 以 escape 後的 `<a href>` 呈現於「相關連結」，附 `target="_blank" rel="noopener noreferrer"`；維持 `pre` 純文字 output。
- [ ] 執行 `node test/aggregate.test.js && node test/dashboardServer.test.js`，確認通過。
- [ ] Commit：`功能：在監控台顯示任務相關連結`。

### Task 3: Matrix 通知優先列出連結

**Files:** Modify `src/notify.js`; Test `test/notify.test.js`.

**Interface:** `writeNotifyFile()` payload 新增 `links: string[]`；`formatNotify()` 在摘要前列出每條 `🔗 URL`。

- [ ] 寫測試：generic output 含 URL 時 payload 有 links，且 `🔗` 行在 `📝` 前面。
- [ ] 執行 `node test/notify.test.js`，確認 `links` 尚不存在而失敗。
- [ ] 匯入 `extractHttpLinks`，由 summary 寫入 links，並在 formatNotify 的摘要前加入連結行。
- [ ] 執行 `node test/notify.test.js && node test/notifySender.test.js`，確認通過。
- [ ] Commit：`功能：任務通知優先附上驗收連結`。

### Task 4: 文件與完整驗證

**Files:** Modify `AGENT_CONTEXT.md`.

- [ ] 文件說明：任務專案可在 generic output 放 HTTP(S) URL，派發器會轉交；不管理 preview process 或檔案託管。
- [ ] 執行 `git diff --check && npm test && npm run test:codex-smoke`。
- [ ] 執行 `rg -n 'spawn\(|spawnSync\(|exec\(|execFile\(' src`，確認僅 `src/codexRunner.js` 建構／啟動 agent CLI。
- [ ] Commit：`文件：說明任務驗收連結轉交`。
