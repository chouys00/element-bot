# Dashboard 驗收後發布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard 驗收一次後，背景通知目標專案 SKILL 以指定分支完成 commit 與 push，並保存 Task-ID、驗收人與驗收時間。

**Architecture:** 規則把 `target_branch` 帶入一般任務；Dashboard 只負責以可信內網署名建立唯一 approval outbox event。獨立 approval worker 透過既有 Codex runtime 邊界通知目標專案，Git 操作完全由專案 SKILL 負責，Dashboard 僅彙整發布狀態。

**Tech Stack:** Node.js 22、CommonJS、Node `http`、檔案式 queue、原生瀏覽器 JavaScript、Codex CLI、Node `assert` 測試。

## Global Constraints

- 任務對話、文件與 Git commit message 使用繁體中文。
- 行為變更遵守 TDD：每項功能先寫會失敗的測試，再做最小實作。
- 只有 `src/codexRunner.js` 可以啟動 Codex；其他模組只能經既有 `ops.runCodex()`。
- element-bot 不得啟動、解析或檢查 Git command；commit 與 push 由目標專案 SKILL 執行。
- 不檢查或硬編碼目標專案 skill 目錄；只通知專案依自身 AGENTS.md、instructions 與 skills 處理。
- 自動測試只能使用暫存目錄與注入的假 Codex，不得觸發正式規則指向的專案。
- 保留工作樹既有 `package-lock.json` 修改，不納入本功能提交。

---

## File Map

- `src/rules.js`：驗證規則的 `target_branch`。
- `src/trigger.js`：把規則分支帶入 task 與 dry-run。
- `src/dashboard/public/rules.html`：編輯 target branch。
- `src/approvalStore.js`：approval event 建立、查詢、狀態搬移的唯一檔案介面。
- `src/executors/approvalExecutor.js`：建立核准通知 prompt，透過 `ops.runCodex()` 通知目標專案。
- `src/approvalWorker.js`：消費、重試及回收 approval outbox。
- `src/dashboard/server.js`：驗收 API，只建立事件，不執行 Codex。
- `src/dashboard/aggregate.js`：把 approval 狀態附到原始任務。
- `src/dashboard/public/index.html`：保存驗收人姓名及顯示發布狀態。
- `src/worker.js`：啟動一般任務與 approval 兩條背景輪詢。

---

### Task 1: 將 target branch 納入規則與任務

**Files:**
- Modify: `src/rules.js`
- Modify: `src/trigger.js`
- Modify: `src/dashboard/public/rules.html`
- Modify: `config/rules.example.json`
- Test: `test/rules.test.js`
- Test: `test/trigger.test.js`
- Test: `test/dashboardServer.test.js`

**Interfaces:**
- Consumes: 現有 rule、task 與 `fillTemplate(template, params)`。
- Produces: `task.target_branch: string`；`dryRunRules()` 每筆結果的 `target_branch`。

- [ ] **Step 1: 寫規則與 trigger 的失敗測試**

在 `test/rules.test.js` 加入：

```js
ok("target_branch 字串通過", validateRule({ ...good, target_branch: "main" }, 0) === true);
throws("target_branch 空字串被拒", () => validateRule({ ...good, target_branch: "" }, 0));
throws("target_branch 非字串被拒", () => validateRule({ ...good, target_branch: 123 }, 0));
```

在該測試建立 `tmpSave` 之後加入：

```js
throws("saveRules 擋 skill-dispatch 缺 target_branch", () => saveRules(tmpSave, [{
  ...goodR,
  task: "skill-dispatch",
  project_path: "D:\\GB\\app",
  command: "處理",
}]));
```

在 `test/trigger.test.js` 的 skill-dispatch 規則加入 `target_branch: "feature/{分支}"`，並斷言：

```js
ok("target_branch 用 params 填充後入列", enqueued[0].target_branch === "feature/activity");
ok("dryRun 帶出 target_branch", fixed.target_branch === "main");
```

在 `test/dashboardServer.test.js` 斷言規則頁具有 `f_target_branch`，並替所有 skill-dispatch 測試規則補上 `target_branch: "main"`。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/rules.test.js; node test/trigger.test.js; node test/dashboardServer.test.js`

Expected: FAIL，因規則、task 與 UI 尚未支援 `target_branch`。

- [ ] **Step 3: 實作最小欄位傳遞**

在 `src/rules.js` 加入與 `project_path` 相同的選填非空字串驗證：

```js
if (rule.target_branch !== undefined && (typeof rule.target_branch !== "string" || !rule.target_branch)) {
  throw new Error(`${where}.target_branch 必須為非空字串`);
}
```

`saveRules()` 對 `task === "skill-dispatch"` 強制 `target_branch` 非空；`loadRules()` 仍可讀取尚未遷移的舊規則，避免服務啟動失敗：

```js
if (r.task === "skill-dispatch" && !r.target_branch) {
  throw new Error(`rules[${i}] skill-dispatch 必須指定 target_branch`);
}
```

在 `src/trigger.js` 建立 task 時加入：

```js
...(rule.target_branch ? { target_branch: fillTemplate(rule.target_branch, params) } : {}),
```

並在 `dryRunRules()` 回傳：

```js
target_branch: rule.target_branch || null,
```

在 `rules.html` 的 `.dispatchonly` 欄位新增 `f_target_branch`，`openEdit()` 載入原值；`applyEdit()` 對 skill-dispatch 強制非空並寫入 rule。`config/rules.example.json` 加入：

```json
"target_branch": "main"
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node test/rules.test.js; node test/trigger.test.js; node test/dashboardServer.test.js`

Expected: 三個測試皆 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/rules.js src/trigger.js src/dashboard/public/rules.html config/rules.example.json test/rules.test.js test/trigger.test.js test/dashboardServer.test.js
git commit -m "新增：任務帶入目標分支"
```

---

### Task 2: 建立獨立 approval outbox 儲存層

**Files:**
- Create: `src/approvalStore.js`
- Create: `test/approvalStore.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `queueDir` 與原始 done task。
- Produces:
  - `findApproval(queueDir, taskId) -> { status, event } | null`
  - `createApproval(queueDir, taskId, task, approvedBy, nowFn?) -> { created, status, event }`
  - `writeApproval(queueDir, status, event) -> event`
  - `moveApproval(queueDir, fromStatus, toStatus, taskId) -> string`
  - `APPROVAL_STATUSES = ["pending", "processing", "done", "failed"]`

- [ ] **Step 1: 建立 outbox 失敗測試**

建立 `test/approvalStore.test.js`，涵蓋：

```js
const task = { task: "skill-dispatch", project_path: "D:\\GB\\app", target_branch: "main" };
const first = createApproval(queueDir, "task-1", task, "王小明", () => new Date("2026-07-21T01:02:03.000Z"));
assert.strictEqual(first.created, true);
assert.deepStrictEqual(first.event, {
  task_id: "task-1",
  project_path: "D:\\GB\\app",
  target_branch: "main",
  approved_by: "王小明",
  approved_at: "2026-07-21T01:02:03.000Z",
  attempt: 0,
});
assert.strictEqual(createApproval(queueDir, "task-1", task, "另一人").created, false);
assert.strictEqual(findApproval(queueDir, "task-1").event.approved_by, "王小明");
```

另外驗證空姓名、控制字元、缺 `project_path`、缺 `target_branch`、非 skill-dispatch、安全 ID與 pending → processing → done 搬移。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/approvalStore.test.js`

Expected: FAIL with `Cannot find module '../src/approvalStore'`。

- [ ] **Step 3: 實作 approvalStore**

使用 `fs.writeFileSync(file, json, { encoding: "utf8", flag: "wx" })` 排他建立 pending event。建立前及收到 `EEXIST` 後都呼叫 `findApproval()`，確保重複 request 回傳既有事件；所有路徑只由通過 `safeId()` 的 task ID 組成。

核心形狀：

```js
const APPROVAL_STATUSES = ["pending", "processing", "done", "failed"];

function createApproval(queueDir, taskId, task, approvedBy, nowFn = () => new Date()) {
  validateApprovalInput(taskId, task, approvedBy);
  const existing = findApproval(queueDir, taskId);
  if (existing) return { created: false, ...existing };
  const event = {
    task_id: taskId,
    project_path: task.project_path,
    target_branch: task.target_branch,
    approved_by: approvedBy.trim(),
    approved_at: nowFn().toISOString(),
    attempt: 0,
  };
  const file = approvalPath(queueDir, "pending", taskId);
  ensureDir(path.dirname(file));
  try {
    fs.writeFileSync(file, JSON.stringify(event, null, 2), { encoding: "utf8", flag: "wx" });
    return { created: true, status: "pending", event };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = findApproval(queueDir, taskId);
    if (!raced) throw error;
    return { created: false, ...raced };
  }
}
```

- [ ] **Step 4: 將測試加入 npm test 並確認通過**

Run: `node test/approvalStore.test.js; npm test`

Expected: approvalStore 測試及完整測試 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/approvalStore.js test/approvalStore.test.js package.json
git commit -m "新增：驗收事件 outbox 儲存層"
```

---

### Task 3: Dashboard 建立驗收事件並顯示發布狀態

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/aggregate.js`
- Modify: `src/dashboard/public/index.html`
- Test: `test/dashboardServer.test.js`
- Test: `test/aggregate.test.js`

**Interfaces:**
- Consumes: Task 2 的 `createApproval()`、`findApproval()`。
- Produces: `POST /api/tasks/:id/approve`；task API 的 `approval` 與 `verified` 欄位。

- [ ] **Step 1: 寫 Dashboard API 失敗測試**

在 `test/dashboardServer.test.js` 建立帶完整欄位的 done task，呼叫：

```js
const approved = await fetch(`${base}/api/tasks/v1/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ approved_by: "王小明", target_branch: "evil" }),
});
assert.strictEqual(approved.status, 201);
const approval = JSON.parse(fs.readFileSync(path.join(queueDir, "approvals", "pending", "v1.json"), "utf8"));
assert.strictEqual(approval.approved_by, "王小明");
assert.strictEqual(approval.target_branch, "main");
```

再驗證重送回 200 且不覆寫人員／時間、非 done 回 409、非 skill-dispatch 回 400、空姓名回 400、缺分支回 400、未知任務回 404、舊 `/verify` 不再建立標記。

在 `test/aggregate.test.js` 建立 pending／processing／done／failed approval event，斷言原始 task 帶：

```js
assert.strictEqual(task.approval.status, "processing");
assert.strictEqual(task.approval.approved_by, "王小明");
assert.strictEqual(task.verified, false);
```

approval done 時 `verified === true`；既有 `verified.json` 仍為 true。

同時斷言 `statusCounts()` 分類正確：未核准為 `unverified`、pending／processing 為 `publishing`、approval failed 為 `publish_failed`、approval done 或 legacy verified 為 `published`。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/dashboardServer.test.js; node test/aggregate.test.js`

Expected: FAIL，因 `/approve` 與 approval 彙整尚不存在。

- [ ] **Step 3: 實作 API 與彙整**

在 `server.js` 只接受 `/api/tasks/:id/approve`：讀取 done task、解析小型 JSON body，將 `approved_by` 交給 `createApproval()`；不得把 request 的 `target_branch`、時間或路徑傳入事件。

回應規則：新建 201、既有 200、輸入錯誤 400、狀態衝突 409、無任務 404。

在 `aggregate.js` 對每個 task 呼叫 `findApproval()`，回傳：

```js
const approval = findApproval(queueDir, id);
verified: isVerified(queueDir, id) || !!(approval && approval.status === "done"),
...(approval ? { approval: { status: approval.status, ...approval.event } } : {}),
```

`statusCounts()` 增加 `publishing`、`publish_failed`、`published`。掃描實體 `done` 任務時依序分類：

```js
if (approval && ["pending", "processing"].includes(approval.status)) counts.publishing++;
else if (approval && approval.status === "failed") counts.publish_failed++;
else if ((approval && approval.status === "done") || isVerified(queueDir, id)) counts.published++;
else counts.unverified++;
```

`review` 只加尚未建立 approval 的 done 任務，不把提交中或發布失敗誤列為待驗收。

- [ ] **Step 4: 實作瀏覽器署名與狀態 UI**

在 header 加入驗收人文字欄，使用固定 key：

```js
const APPROVER_KEY = "element-bot.approved-by";
function approverName() {
  return document.getElementById("approverName").value.trim();
}
```

輸入變更時寫入 `localStorage`。按驗收時若姓名空白就顯示錯誤；否則 POST `{ approved_by }`。狀態映射新增：

```js
if (t.approval && ["pending", "processing"].includes(t.approval.status)) return "publishing";
if (t.approval && t.approval.status === "failed") return "publish_failed";
```

有 approval event 後不再顯示可點擊驗收按鈕，詳情顯示核准人、核准時間及發布狀態。
頂部統計直接使用 `published`、`publishing`、`publish_failed` 與 `unverified`，不再用 `done - unverified` 推算完成數。

- [ ] **Step 5: 執行測試確認通過**

Run: `node test/dashboardServer.test.js; node test/aggregate.test.js; npm test`

Expected: 所有測試 PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/dashboard/server.js src/dashboard/aggregate.js src/dashboard/public/index.html test/dashboardServer.test.js test/aggregate.test.js
git commit -m "新增：Dashboard 建立驗收發布事件"
```

---

### Task 4: 通知專案 SKILL 執行 commit 與 push

**Files:**
- Create: `src/executors/approvalExecutor.js`
- Create: `test/approvalExecutor.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: approval event、既有 `ops.runCodex(prompt, projectDir)` 與 `parseTaskResult(stdout)`。
- Produces:
  - `buildApprovalPrompt(event) -> string`
  - `approvalExecutor(event, deps?) -> Promise<{ status, output }>`

- [ ] **Step 1: 寫 executor 失敗測試**

建立 `test/approvalExecutor.test.js`，注入假的 `runCodex`：

```js
const event = {
  task_id: "task-1",
  project_path: "D:\\GB\\app",
  target_branch: "release/task-1",
  approved_by: "王小明",
  approved_at: "2026-07-21T01:02:03.000Z",
};
const result = await approvalExecutor(event, {
  runCodex: async (prompt, cwd) => {
    assert.strictEqual(cwd, event.project_path);
    for (const value of [event.task_id, event.target_branch, event.approved_by, event.approved_at]) {
      assert.ok(prompt.includes(value));
    }
    assert.ok(prompt.includes("Task-ID: task-1"));
    assert.ok(prompt.includes("Approved-by: 王小明"));
    assert.ok(prompt.includes("commit") && prompt.includes("push"));
    assert.ok(prompt.includes("AGENTS.md") && prompt.includes("skills"));
    return JSON.stringify({ status: "success", output: "已發布" });
  },
});
assert.deepStrictEqual(result, { status: "success", output: "已發布" });
```

另斷言 prompt 不含任何 `.agents/skills`、`.claude/skills` 等固定路徑，並要求先依 Task-ID 判斷是否已發布，重送時不得重複提交。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/approvalExecutor.test.js`

Expected: FAIL with `Cannot find module '../src/executors/approvalExecutor'`。

- [ ] **Step 3: 實作 executor**

`approvalExecutor()` 只做兩件事：以完整、固定格式建立通知 prompt；呼叫注入的 `runCodex` 並使用 `parseTaskResult()` 驗證 `{ status, output }`。不得 import `child_process`、Git library 或讀取目標專案工具目錄。

Prompt 明確包含：

```text
這是一筆已完成 Dashboard 人工驗收的發布通知。
請依本專案自己的 AGENTS.md、instructions、skills 與安全規則處理。
task_id: ...
target_branch: ...
approved_by: ...
approved_at: ...
請先以 Task-ID 判斷是否已完成相同發布；若已完成，驗證後回報 success，不得重複 commit。
若尚未完成，請將本任務既有變更 commit 並 push 到 target_branch。
commit message 必須包含：
Task-ID: ...
Approved-by: ...
```

- [ ] **Step 4: 將測試加入 npm test 並確認通過**

Run: `node test/approvalExecutor.test.js; npm test`

Expected: approvalExecutor 與完整測試 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/executors/approvalExecutor.js test/approvalExecutor.test.js package.json
git commit -m "新增：驗收後通知專案發布"
```

---

### Task 5: 背景消費、重試與崩潰復原

**Files:**
- Create: `src/approvalWorker.js`
- Create: `test/approvalWorker.test.js`
- Modify: `src/worker.js`
- Modify: `src/config.js`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 store、Task 4 `approvalExecutor(event)`。
- Produces:
  - `processApproval(filePath, deps) -> Promise<"done" | "retry" | "failed">`
  - `pollApprovals(deps) -> Promise<number>`
  - `recoverApprovals(queueDir, logger, maxAttempts) -> number`

- [ ] **Step 1: 寫 worker 失敗測試**

建立 `test/approvalWorker.test.js`，使用暫存 queue 與 fake executor，驗證：

- pending 先移 processing，成功後事件加上 `result`、`completed_at` 並移 done。
- executor 丟錯時 `attempt` 加一；未達上限移回 pending 並回 `retry`。
- 達上限移 failed，保存 `last_error`，不得要求再次人工驗收。
- processing 殘留在啟動時移回 pending；已達上限則移 failed。
- executor 收到的事件四欄未變。

核心成功斷言：

```js
assert.strictEqual(await processApproval(file, deps), "done");
const saved = JSON.parse(fs.readFileSync(path.join(queueDir, "approvals", "done", "task-1.json"), "utf8"));
assert.strictEqual(saved.attempt, 1);
assert.strictEqual(saved.result.status, "success");
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/approvalWorker.test.js`

Expected: FAIL with `Cannot find module '../src/approvalWorker'`。

- [ ] **Step 3: 實作背景消費與 recovery**

`processApproval()` 必須先 rename 到 processing，再增加 attempt 並原子重寫事件。只有 `result.status === "success"` 才移 done；其餘 structured status 以錯誤處理並依上限重試。

`worker.js` 啟動時同時呼叫：

```js
recoverProcessing(config.queueDir, logger, config.maxTaskAttempts);
recoverApprovals(config.queueDir, logger, config.maxApprovalAttempts);
```

每輪依序執行一般任務與 approval：

```js
await pollOnce(deps);
await pollApprovals(approvalDeps);
```

`config.js` 新增 `MAX_APPROVAL_ATTEMPTS`，預設 3；`.env.example` 記錄其用途。

- [ ] **Step 4: 將測試加入 npm test 並確認通過**

Run: `node test/approvalWorker.test.js; npm test`

Expected: approval worker 與完整測試 PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/approvalWorker.js test/approvalWorker.test.js src/worker.js src/config.js .env.example package.json
git commit -m "新增：背景處理驗收發布事件"
```

---

### Task 6: 防退化、操作文件與完整驗證

**Files:**
- Modify: `test/runtimeMigration.test.js`
- Modify: `AGENT_CONTEXT.md`
- Modify: `README.md`
- Test: entire suite

**Interfaces:**
- Consumes: 完整 approval workflow。
- Produces: Git/runtime 邊界防退化測試與操作說明。

- [ ] **Step 1: 先加 element-bot 不執行 Git 的失敗防退化測試**

在 `test/runtimeMigration.test.js` 掃描 `src/`，找出直接啟動 Git 的檔案：

```js
const gitLaunchFiles = filesUnder(path.join(repo, "src"))
  .filter((file) => /(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*["'`]git["'`]/i.test(fs.readFileSync(file, "utf8")))
  .map((file) => path.relative(repo, file).replace(/\\/g, "/"));
assert.deepStrictEqual(gitLaunchFiles, [], `element-bot 不得直接啟動 Git: ${gitLaunchFiles.join(", ")}`);
```

保留既有 agent CLI 只能由 `src/codexRunner.js` 啟動的斷言。

- [ ] **Step 2: 執行防退化測試**

Run: `node test/runtimeMigration.test.js`

Expected: PASS；若任何新模組直接啟動 Git 則 FAIL。

- [ ] **Step 3: 更新文件**

`AGENT_CONTEXT.md` 記錄：規則的 `target_branch`、approval 事件四欄、可信內網署名、狀態目錄與 target project 負責 commit/push。`README.md` 加入一次性設定 Dashboard 驗收人姓名及發布狀態說明。

- [ ] **Step 4: 執行完整驗證**

Run: `npm test`

Expected: 全部 PASS。

Run: `npm run test:codex-smoke`

Expected: Codex smoke test PASS，且不修改目標專案。

Run: `git diff --check`

Expected: 無輸出。

Run: `rg -n "(?:spawn|spawnSync|execFile|execFileSync|exec|execSync).*git" src`

Expected: 無直接 Git 啟動程式碼。

Run: `git status --short`

Expected: 只列本功能檔案與原先既有的 `package-lock.json` 修改；後者不得 stage。

- [ ] **Step 5: 提交文件與防退化測試**

```powershell
git add test/runtimeMigration.test.js AGENT_CONTEXT.md README.md
git commit -m "文件：補充驗收後發布流程"
```

- [ ] **Step 6: 最終人工檢查**

以 Dashboard 測試資料確認：輸入驗收人姓名一次、完成任務只出現一個驗收按鈕、按下後立即顯示提交中、一般任務清單沒有第二筆內部發布任務。不得使用正式規則或正式目標專案進行此檢查。
