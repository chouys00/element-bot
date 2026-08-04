# Codex 驗收對話續接與七日清理實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓驗收與重試精確續接原本執行任務的 Codex session，並在推送成功或人工關閉滿 7 天後安全刪除 element-bot 自己保存的 session。

**Architecture:** `codexRunner` 負責持久化／續接／刪除 Codex session 與解析 JSONL；任務工作目錄保存精確 session metadata，驗收事件複製該 ID 後只用指定 ID resume。獨立清理模組根據驗收或關閉事件判斷期限，由既有 worker 啟動時及每 24 小時最多執行一次。

**Tech Stack:** Node.js CommonJS、Codex CLI JSONL、現有 JSON queue／worker、`node:assert` 測試。

## Global Constraints

- Codex 是唯一 agent runtime，只有 `src/codexRunner.js` 可以建構或啟動 Codex CLI。
- `judge` 與 `probe` 維持 `--ephemeral`；真正修改專案的 execute、驗收與重試不使用 `--ephemeral`。
- resume 只能使用事件保存的精確 UUID，不得使用 `--last`，也不得在缺少 ID 時另開對話。
- session 只在推送成功或人工關閉滿 7 天後刪除；其他狀態與舊資料一律保留或跳過。
- 清理失敗不改變任務狀態，並在下一個 24 小時週期重試；若官方介面已移除 rollout、只剩 Codex 索引錯誤，記錄警告後視為內容已刪除。
- element-bot 不執行 Git add、commit、push；既有 Git 唯讀驗證與暫時 Git `user.name` 邊界維持不變。
- 依專案規範，Git commit、push 與服務重啟仍需另外取得明確授權；執行本計畫時不自行執行。

---

### Task 1: Codex runner 的持久化、resume 與 delete 邊界

**Files:**
- Modify: `src/codexRunner.js`
- Modify: `test/codexRunner.test.js`

**Interfaces:**
- Consumes: 既有 `runCodex(prompt, options)`、runtime preflight 與 Windows process-tree timeout。
- Produces: `runCodex(..., { persistSession: true }) -> { output, sessionId }`、`runCodex(..., { resumeSessionId }) -> { output, sessionId }`、`deleteCodexSession(sessionId, options) -> Promise<{ deleted, metadataDeleted, warning? }>`。

- [ ] **Step 1: 寫出 runner 參數與 JSONL 的失敗測試**

```js
const SESSION_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const persistent = buildCodexArgs("execute", { persistSession: true });
assert.ok(persistent.includes("--json"));
assert.ok(!persistent.includes("--ephemeral"));
assert.deepStrictEqual(
  persistent.slice(persistent.indexOf("exec"), persistent.indexOf("exec") + 2),
  ["exec", "--json"],
);

const resumed = buildCodexArgs("execute", { resumeSessionId: SESSION_ID });
assert.ok(resumed.includes("resume"));
assert.ok(resumed.includes(SESSION_ID));
assert.ok(!resumed.includes("--last"));
assert.ok(!resumed.includes("--ephemeral"));
```

以 fake child 回傳 `thread.started`、`item.completed(agent_message)` 與 `turn.completed`，斷言 `runCodex` 回傳同一個 `sessionId` 及最後 agent message；再加入缺少 thread、不同 thread ID、缺少 agent message、非法 JSONL 與 delete 非 UUID 的測試。

- [ ] **Step 2: 執行測試並確認因功能尚未存在而失敗**

Run: `node test/codexRunner.test.js`

Expected: FAIL，指出 execute 仍含 `--ephemeral`、沒有 JSONL 結果物件或尚未匯出 `deleteCodexSession`。

- [ ] **Step 3: 實作最小 runner 行為**

```js
function validSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function parseCodexJsonl(stdout, expectedSessionId) {
  const events = String(stdout || "").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "thread.started");
  const messages = events.filter((event) =>
    event.type === "item.completed" && event.item && event.item.type === "agent_message");
  if (!started || !validSessionId(started.thread_id)) throw new Error("Codex JSONL 缺少合法 thread ID");
  if (expectedSessionId && started.thread_id !== expectedSessionId) throw new Error("Codex resume session ID 不一致");
  if (!messages.length) throw new Error("Codex JSONL 缺少最終 agent message");
  return { sessionId: started.thread_id, output: String(messages[messages.length - 1].item.text || "") };
}
```

`buildCodexArgs` 對既有 ephemeral 模式維持原參數；`persistSession` 加上 `--json` 並移除 `--ephemeral`；`resumeSessionId` 建構 `exec resume --json ... <UUID> -`。`deleteCodexSession` 通過同一 preflight，以 `shell:false` 啟動官方 app-server，完成握手後呼叫 `thread/delete`，並沿用短 timeout 與 process-tree 終止。若 Codex 回報索引錯誤，再以 `thread/read` 唯讀確認 rollout 是否已消失；內容確實刪除時回傳警告，不能直接改 Codex 資料庫。

- [ ] **Step 4: 執行 runner 測試並確認通過**

Run: `node test/codexRunner.test.js`

Expected: PASS，且 judge／probe 的既有 ephemeral、簽章、登入與 timeout 測試仍通過。

- [ ] **Step 5: 保留提交點但不自行提交**

取得明確授權後才可執行：

```text
git add src/codexRunner.js test/codexRunner.test.js
git commit -m "支援 Codex 任務對話保存與續接"
```

### Task 2: 任務 session metadata 與驗收精確續接

**Files:**
- Create: `src/codexSessionStore.js`
- Create: `test/codexSessionStore.test.js`
- Modify: `src/executors/ops.js`
- Modify: `src/executors/defaultHandlers.js`
- Modify: `src/executors/approvalExecutor.js`
- Modify: `src/approvalStore.js`
- Modify: `src/dashboard/server.js`
- Modify: `test/defaultHandlers.test.js`
- Modify: `test/approvalExecutor.test.js`
- Modify: `test/approvalStore.test.js`
- Modify: `test/dashboardServer.test.js`
- Modify: `test/directProjectExecution.test.js`

**Interfaces:**
- Consumes: Task 1 的持久化／resume `runCodex` 結果。
- Produces: `writeCodexSession(workDir, session)`、`readCodexSession(workDir)`、approval event 的 `codex_session_id`，以及只用該 ID resume 的驗收 executor。

- [ ] **Step 1: 寫出 metadata、驗收建立與 resume 的失敗測試**

```js
writeCodexSession(workDir, {
  session_id: SESSION_ID,
  task_id: "task-1",
  created_at: "2026-08-04T00:00:00.000Z",
});
assert.strictEqual(readCodexSession(workDir).session_id, SESSION_ID);

const approval = createApproval(queueDir, "task-1", task, "patrick.zyx");
assert.strictEqual(approval.event.codex_session_id, SESSION_ID);
```

另測試：非法 UUID、metadata task ID 不符、缺少 metadata 時 approve 被拒絕、舊 approval event 仍可讀取但不能啟動新對話、`approvalExecutor` 第三個參數為 `{ resumeSessionId: SESSION_ID }`，以及 retry 沿用原 ID。

- [ ] **Step 2: 執行相關測試並確認正確失敗**

Run: `node test/codexSessionStore.test.js && node test/defaultHandlers.test.js && node test/approvalStore.test.js && node test/approvalExecutor.test.js && node test/dashboardServer.test.js`

Expected: FAIL，指出 metadata 模組不存在、approval 沒有 session ID 或驗收仍以新對話呼叫。

- [ ] **Step 3: 實作 metadata 與驗收資料流**

```js
const SESSION_FILE = "codex-session.json";

function writeCodexSession(workDir, value) {
  const session = validateCodexSession(value);
  writeJsonAtomic(path.join(workDir, SESSION_FILE), session);
  return session;
}

function readCodexSession(workDir) {
  const value = readJsonSafe(path.join(workDir, SESSION_FILE), null);
  return value ? validateCodexSession(value) : null;
}
```

`ops.runCodex(prompt, projectDir, options)` 對 execute 預設 `persistSession: true`；`defaultHandlers.ai_run` 在解析模型結果前寫入 metadata。`createApproval` 從 `queue/work/<task_id>` 讀取並交叉驗證 task ID，複製 `codex_session_id`；缺少時拋出清楚錯誤。`approvalExecutor` 呼叫：

```js
runCodex(buildApprovalPrompt(event), event.project_path, {
  resumeSessionId: event.codex_session_id,
});
```

Dashboard approve 將缺少 session 的錯誤回傳為可讀的 409，不建立 approval event。

- [ ] **Step 4: 執行相關測試並確認通過**

Run: `node test/codexSessionStore.test.js && node test/defaultHandlers.test.js && node test/approvalStore.test.js && node test/approvalExecutor.test.js && node test/dashboardServer.test.js && node test/directProjectExecution.test.js`

Expected: PASS，且每個新式驗收事件都帶精確 session ID。

- [ ] **Step 5: 保留提交點但不自行提交**

取得明確授權後才可執行：

```text
git add src/codexSessionStore.js src/executors src/approvalStore.js src/dashboard/server.js test
git commit -m "讓驗收續接原 Codex 任務對話"
```

### Task 3: 七日保存與低頻安全清理

**Files:**
- Create: `src/codexSessionCleanup.js`
- Create: `test/codexSessionCleanup.test.js`
- Modify: `src/worker.js`
- Modify: `src/workerLoop.js`
- Modify: `test/workerLoop.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 的 `deleteCodexSession`、Task 2 的 metadata、現有 `findApproval` 與 `findClosure`。
- Produces: `cleanupExpiredCodexSessions(deps) -> Promise<{ scanned, deleted, skipped, failed }>` 與 `createCodexSessionCleanupScheduler(deps) -> { poll() }`。

- [ ] **Step 1: 寫出期限、安全條件與排程的失敗測試**

```js
const result = await cleanupExpiredCodexSessions({
  queueDir,
  now: () => new Date("2026-08-12T00:00:00.000Z"),
  deleteSession: async (id) => deleted.push(id),
});
assert.deepStrictEqual(deleted, [SESSION_ID]);
assert.strictEqual(result.deleted, 1);
```

分別建立成功未滿 7 天、成功已滿 7 天、failed、unknown、pending、processing、人工關閉已滿 7 天、缺少 metadata、非法 UUID、approval 與 metadata ID 不一致、已 `deleted_at`、delete 拋錯等案例。排程測試斷言啟動時執行一次，24 小時內不重跑，滿 24 小時才再執行。

- [ ] **Step 2: 執行測試並確認因清理功能不存在而失敗**

Run: `node test/codexSessionCleanup.test.js && node test/workerLoop.test.js`

Expected: FAIL，指出清理模組不存在或 worker 尚未觸發清理。

- [ ] **Step 3: 實作七日清理與 worker 排程**

```js
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function terminalTime(queueDir, taskId, sessionId) {
  const closure = findClosure(queueDir, taskId);
  if (closure) return Date.parse(closure.closed_at);
  const approval = findApproval(queueDir, taskId);
  if (!approval || approval.status !== "done" || !approval.event.publish ||
      approval.event.publish.status !== "success" || approval.event.codex_session_id !== sessionId) return null;
  return Date.parse(approval.event.publish.finished_at);
}
```

清理逐一讀取 `queue/work/*/codex-session.json`，只有 `now - terminalTime >= RETENTION_MS` 才呼叫 delete；目前與被取代的 session ID 都逐一處理，並以 `deleted_session_ids` 保存中途進度。全部成功後寫入 `deleted_at`；Codex 已移除 rollout 但索引仍殘留時另寫 `delete_warning`；失敗寫入 `delete_attempted_at` 與截短的 `delete_error`，繼續處理其他項目。scheduler 把 `last_run_at` 寫入 queue，worker 重啟仍受 24 小時限制；重新開啟與清理共用跨程序任務鎖，不新增 timer 或背景程序。

- [ ] **Step 4: 執行清理與 worker 測試並確認通過**

Run: `node test/codexSessionCleanup.test.js && node test/workerLoop.test.js`

Expected: PASS，且所有非終態、未滿期限與證據不足案例都沒有呼叫 delete。

- [ ] **Step 5: 保留提交點但不自行提交**

取得明確授權後才可執行：

```text
git add src/codexSessionCleanup.js src/worker.js src/workerLoop.js test/codexSessionCleanup.test.js test/workerLoop.test.js package.json
git commit -m "加入 Codex 任務對話七日清理"
```

### Task 4: 規範、相容性與完整驗證

**Files:**
- Modify: `AGENTS.md`
- Modify: `AGENT_CONTEXT.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `test/repositoryInstructions.test.js`
- Modify: `test/runtimeMigration.test.js`
- Modify: `test/codexSmoke.test.js`

**Interfaces:**
- Consumes: 前三項完成的 runner、驗收與清理行為。
- Produces: 明確 runtime 邊界、保存週期文件與端對端驗證。

- [ ] **Step 1: 寫出規範與 smoke 契約的失敗測試**

```js
assert.match(agents, /deleteCodexSession/);
assert.match(agents, /7 天/);
assert.match(readme, /精確.*session ID/);
assert.doesNotMatch(runtimeSourcesOutsideRunner, /["'`]delete["'`]/);
```

更新 smoke wrapper 讓初次 execute 回傳 session ID，驗收斷言 resume 使用同一 ID；臨時 repo 與本機 bare remote 維持既有隔離，不接觸正式專案或外部 remote。

- [ ] **Step 2: 執行規範測試並確認正確失敗**

Run: `node test/repositoryInstructions.test.js && node test/runtimeMigration.test.js`

Expected: FAIL，指出文件尚未記錄 session 保存／刪除邊界。

- [ ] **Step 3: 更新文件與 smoke 測試**

在文件中明確寫出：execute／approval／retry 保存同一 session、judge／probe ephemeral、成功或關閉後保存 7 天、worker 每 24 小時最多檢查一次、只有 runner 可呼叫 app-server `thread/delete`、清理不啟動模型且失敗不影響任務狀態。

- [ ] **Step 4: 執行完整驗證**

Run: `npm test`

Expected: 全部 PASS。

Run: `npm run test:codex-smoke`

Expected: 真實 Codex 初次執行與驗收 resume 使用同一 session，臨時 repo 推送至本機 bare remote 成功。

Run: `git diff --check`

Expected: 無輸出、exit 0。

Run: `rg -n 'claude|gemini|cursor|child_process|spawn\(' src --glob '*.js'`

Expected: runtime 只有 Codex；`child_process`／`spawn` 只存在於允許的 runner 與既有非 agent Git／程序模組，沒有新增其他 agent CLI。

Run: `rg -n '["'"'"'`](add|commit|push|fetch|pull)["'"'"'`]' src/approvalGitVerification.js src/codexSessionCleanup.js`

Expected: 無 element-bot Git 寫入命令；清理模組也沒有自行建構 Codex CLI 命令。

- [ ] **Step 5: 保留最終提交點但不自行提交**

取得明確授權後才可執行：

```text
git add AGENTS.md AGENT_CONTEXT.md README.md .env.example test src package.json docs/superpowers
git commit -m "完成驗收對話續接與七日保存"
```
