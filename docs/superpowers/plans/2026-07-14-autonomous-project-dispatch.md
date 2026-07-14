# Autonomous Project Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make element-bot a transparent dispatcher that gives the target project an autonomous Codex execution and returns a schema-validated result to the queue, dashboard, and notifications.

**Architecture:** Judge and probe remain read-only, while execute uses `danger-full-access` and a target-neutral prompt. A focused task-result module owns the JSON schema, parsing, and status mapping; handlers persist the Codex result so checkpoint resumes are safe. Worker and dashboard statuses are driven by the structured result, while git data is observational only.

**Tech Stack:** Node.js CommonJS, Codex CLI `exec --output-schema`, filesystem queue/NDJSON logs, vanilla browser dashboard, existing assertion-based Node test suite.

## Global Constraints

- Element-bot only selects the configured target project and command; it must not encode target-specific skill, credential, validation, or commit rules.
- `judge` and `probe` remain `read-only` with network disabled.
- Only `execute` uses `danger-full-access` with network enabled and approval policy `never`.
- Chat input cannot override `project_path` or Codex CLI arguments.
- Task success comes from process health plus a schema-valid result, never from the existence of a git diff.
- Never copy credentials into prompts, task JSON, logs, or result objects.
- Preserve timeout and full process-tree termination behavior.

---

## File Structure

- Create `src/executors/taskResult.js`: one owner for execute result schema, JSON parsing, validation, and queue status mapping.
- Create `test/taskResult.test.js`: contract tests for all result states and malformed output.
- Modify `src/codexRunner.js` and `test/codexRunner.test.js`: execute sandbox parity while preserving judge/probe isolation.
- Modify `src/taskDefs.js` and `test/taskDefs.test.js`: transparent handoff prompt with no project workflow policy.
- Modify `src/executors/ops.js`, `src/executors/defaultHandlers.js`, and `test/defaultHandlers.test.js`: pass the schema, persist results, remove git cleanliness and git-based success decisions.
- Modify `src/executors/agentExecutor.js`, `src/workerCore.js`, `test/agentExecutor.test.js`, and `test/workerCore.test.js`: return and route structured statuses.
- Modify `src/dashboard/aggregate.js`, `src/dashboard/public/index.html`, `src/notify.js`, `test/aggregate.test.js`, and `test/notify.test.js`: expose blocked/partial results and their evidence.
- Modify `package.json`: add the new task-result test to the standard test command.

---

### Task 1: Structured Task Result Contract

**Files:**
- Create: `src/executors/taskResult.js`
- Create: `test/taskResult.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `TASK_RESULT_SCHEMA: object`
- Produces: `parseTaskResult(stdout: string): TaskResult`, throwing `Error("Codex 結果回報格式錯誤: ...")`
- Produces: `queueStatus(resultStatus: string): "done" | "failed" | "blocked" | "review"`
- `TaskResult` contains `status`, `summary`, `changes`, `validation`, `commits`, and `warnings`.

- [ ] **Step 1: Write the failing contract test**

```js
const assert = require("assert");
const { TASK_RESULT_SCHEMA, parseTaskResult, queueStatus } = require("../src/executors/taskResult");

const valid = {
  status: "success",
  summary: "已完成",
  changes: [],
  validation: [{ command: "npm test", status: "passed", detail: "all passed" }],
  commits: [],
  warnings: [],
};
assert.deepStrictEqual(parseTaskResult(JSON.stringify(valid)), valid);
assert.strictEqual(queueStatus("success"), "done");
assert.strictEqual(queueStatus("failed"), "failed");
assert.strictEqual(queueStatus("blocked"), "blocked");
assert.strictEqual(queueStatus("partial"), "review");
assert.throws(() => parseTaskResult("not json"), /結果回報格式錯誤/);
assert.throws(() => parseTaskResult('{"status":"success"}'), /結果回報格式錯誤/);
assert.deepStrictEqual(TASK_RESULT_SCHEMA.required,
  ["status", "summary", "changes", "validation", "commits", "warnings"]);
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node test/taskResult.test.js`

Expected: FAIL with `Cannot find module '../src/executors/taskResult'`.

- [ ] **Step 3: Implement the schema and strict parser**

```js
"use strict";

const RESULT_STATUSES = ["success", "failed", "blocked", "partial"];
const VALIDATION_STATUSES = ["passed", "failed", "skipped", "not_applicable"];

const TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: RESULT_STATUSES },
    summary: { type: "string", minLength: 1 },
    changes: { type: "array", items: { type: "string" } },
    validation: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          status: { type: "string", enum: VALIDATION_STATUSES },
          detail: { type: "string" },
        },
        required: ["command", "status", "detail"],
        additionalProperties: false,
      },
    },
    commits: {
      type: "array",
      items: {
        type: "object",
        properties: { hash: { type: "string" }, message: { type: "string" } },
        required: ["hash", "message"],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "changes", "validation", "commits", "warnings"],
  additionalProperties: false,
};
```

Implement `parseTaskResult` with `JSON.parse`, exact key/array checks, enum checks, and per-entry string checks so fake runners and malformed saved output are also rejected without relying solely on Codex CLI schema enforcement. Implement the four-value `queueStatus` mapping and throw for unknown status.

- [ ] **Step 4: Add the test to `npm test` and verify**

Run: `node test/taskResult.test.js`

Expected: PASS and print the test completion line.

- [ ] **Step 5: Commit the result contract**

```bash
git add src/executors/taskResult.js test/taskResult.test.js package.json
git commit -m "feat: add structured project task result contract"
```

---

### Task 2: Runtime Permissions and Transparent Handoff

**Files:**
- Modify: `src/codexRunner.js`
- Modify: `test/codexRunner.test.js`
- Modify: `src/taskDefs.js`
- Modify: `test/taskDefs.test.js`

**Interfaces:**
- Consumes: existing `buildCodexArgs(mode, options)` and `runCodex(prompt, options)`.
- Produces: execute arguments containing `--sandbox danger-full-access`; judge/probe stay unchanged.
- Produces: `skill-dispatch.prompt(task)` containing only target context, command, project instructions/skills handoff, and structured-report request.

- [ ] **Step 1: Change runner tests to express the intended permission boundary**

```js
const executeArgs = buildCodexArgs("execute");
ok("execute 使用 danger-full-access", executeArgs.includes("danger-full-access"));
ok("execute 不使用 workspace-write", !executeArgs.includes("workspace-write"));
ok("execute 不加入 workspace-write 專用網路設定",
  !executeArgs.includes("sandbox_workspace_write.network_access=true"));
```

Keep the existing judge/probe read-only assertions.

- [ ] **Step 2: Change prompt tests to reject dispatcher policy injection**

```js
const prompt = def.prompt({ command: "https://zentao.example/bug-view-1.html" });
ok("prompt 將 command 視為專案內直接輸入", prompt.includes("直接在此專案"));
ok("prompt 要求依專案 instructions 與 skills 執行", prompt.includes("instructions") && prompt.includes("skills"));
ok("prompt 要求結構化回報", prompt.includes("指定 schema"));
for (const forbidden of ["不得讀寫工作目錄之外", "預設不 commit", "絕不自作主張", ".claude/skills", ".cursor/skills"]) {
  ok(`prompt 不含派發器政策: ${forbidden}`, !prompt.includes(forbidden));
}
```

- [ ] **Step 3: Run focused tests and confirm they fail**

Run: `node test/codexRunner.test.js && node test/taskDefs.test.js`

Expected: FAIL because execute still uses `workspace-write` and the prompt still contains the safety and commit rules.

- [ ] **Step 4: Implement runtime and prompt changes**

Change mode config to:

```js
const MODE_CONFIG = Object.freeze({
  judge: { sandbox: "read-only", network: false },
  probe: { sandbox: "read-only", network: false },
  execute: { sandbox: "danger-full-access", network: true },
});
```

Only add `sandbox_workspace_write.network_access=true` when the chosen sandbox is `workspace-write`. Replace the dispatch prompt with:

```js
return [
  "你正在規則指定的目標專案中執行任務。",
  "請把下方 command 視為使用者直接在此專案提出的要求。",
  "依此專案自身的 AGENTS.md、instructions 與 skills 完整執行；element-bot 不介入專案如何修改、驗證或提交。",
  "command：" + command,
  "完成後依指定 schema 回報實際結果與證據；不得在回報中包含 token、密碼或其他秘密內容。",
].join("\n");
```

- [ ] **Step 5: Run focused tests and commit**

Run: `node test/codexRunner.test.js && node test/taskDefs.test.js`

Expected: PASS.

```bash
git add src/codexRunner.js test/codexRunner.test.js src/taskDefs.js test/taskDefs.test.js
git commit -m "fix: restore autonomous Codex project execution"
```

---

### Task 3: Persist and Summarize the Target Project Result

**Files:**
- Modify: `src/executors/ops.js`
- Modify: `src/executors/defaultHandlers.js`
- Modify: `test/defaultHandlers.test.js`

**Interfaces:**
- Consumes: `TASK_RESULT_SCHEMA`, `parseTaskResult`, and `queueStatus` from Task 1.
- Changes: `ops.runCodex(prompt, projectDir)` invokes execute with `outputSchema: TASK_RESULT_SCHEMA`.
- Produces: `work/<id>/task-result.json` containing the parsed result for checkpoint-safe resume.
- Produces: summarize object `{ status, summary, changes, validation, commits, warnings, produced, openPath, queueStatus }`.

- [ ] **Step 1: Replace git-based handler tests with result-driven tests**

Add cases asserting:

```js
const success = {
  status: "success", summary: "分析完成，不需改檔", changes: [],
  validation: [], commits: [], warnings: [],
};
const h = make({ runCodex: async () => JSON.stringify(success), gitHead: () => "abc" });
await h.prepare({ workDir, task: TASK, emit: noop, shared: {} });
await h.ai_run({ workDir, task: TASK, emit: noop, shared: {} });
const sum = await h.summarize({ workDir, task: TASK, emit: noop, shared: {} });
ok("無 git diff 的 success 仍成功", sum.status === "success" && sum.queueStatus === "done");
```

Also test `blocked -> blocked`, `partial -> review`, `failed -> failed`, malformed JSON rejection, persistence across a new `shared` object, and that `prepare` does not call `gitClean`.

- [ ] **Step 2: Run the focused test and verify old behavior fails**

Run: `node test/defaultHandlers.test.js`

Expected: FAIL because prepare calls `gitClean`, ai_run does not persist a result, and summarize uses git changes.

- [ ] **Step 3: Pass the output schema in ops**

```js
const { TASK_RESULT_SCHEMA } = require("./taskResult");

function runCodex(prompt, projectDir) {
  return invokeCodex(prompt, {
    mode: "execute",
    cwd: projectDir,
    outputSchema: TASK_RESULT_SCHEMA,
  });
}
```

- [ ] **Step 4: Replace handler workflow decisions with result persistence**

Implement handlers as follows:

- `prepare`: resolve the configured project and record the current HEAD when available, but never require a clean worktree.
- `ai_run`: call Codex, parse with `parseTaskResult`, persist with `writeJsonAtomic(path.join(workDir, "task-result.json"), result)`, store in `shared.taskResult`, and emit the safe raw JSON output subject to the existing size cap.
- `verify`: no-op except recording that validation is owned by the target project.
- `summarize`: load `shared.taskResult` or persisted `task-result.json`, map its status with `queueStatus`, and return all report evidence. Set `produced` to `result.changes` and `openPath` to the target project.

Do not call `gitChanged` or use HEAD differences to change the result status. Retain git helper functions only if needed for optional display data; remove unused exports and tests otherwise.

- [ ] **Step 5: Run focused tests and commit**

Run: `node test/defaultHandlers.test.js && node test/executorIntegration.test.js`

Expected: PASS.

```bash
git add src/executors/ops.js src/executors/defaultHandlers.js test/defaultHandlers.test.js test/executorIntegration.test.js
git commit -m "feat: drive project completion from structured results"
```

---

### Task 4: Route Success, Failure, Blocked, and Partial Results

**Files:**
- Modify: `src/executors/agentExecutor.js`
- Modify: `src/workerCore.js`
- Modify: `test/agentExecutor.test.js`
- Modify: `test/workerCore.test.js`

**Interfaces:**
- Changes: `agentExecutor(...) -> Promise<Summary>` returns the summarize result after logging it.
- Changes: `processOne(...) -> Promise<"done" | "failed" | "blocked" | "review">` moves the task to the matching directory.
- Consumes: summary property `queueStatus` from Task 3.

- [ ] **Step 1: Add executor and worker status tests**

```js
const result = await agentExecutor(task, context);
ok("executor 回傳 summarize 結果", result.queueStatus === "blocked");
```

Add worker cases where executor returns `{ queueStatus: "blocked" }`, `{ queueStatus: "review" }`, and `{ queueStatus: "failed", summary: "tests failed" }`; assert the JSON moves to that directory and notify receives the same status. Keep thrown infrastructure errors mapped to `failed` with `.error.txt`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node test/agentExecutor.test.js && node test/workerCore.test.js`

Expected: FAIL because executor returns nothing and worker always routes non-throwing execution to `done`.

- [ ] **Step 3: Return summary and route queue status**

At the end of `agentExecutor`, return `summary` after emitting it. In `processOne`, validate the returned `queueStatus` against `done`, `failed`, `blocked`, and `review`; default legacy executors with no result to `done`. Move the processing JSON to the matching directory and notify using that status.

For a structured `failed` result, write `.error.txt` only when there is an infrastructure exception; the full target report remains in the NDJSON log.

- [ ] **Step 4: Run focused tests and commit**

Run: `node test/agentExecutor.test.js && node test/workerCore.test.js`

Expected: PASS.

```bash
git add src/executors/agentExecutor.js src/workerCore.js test/agentExecutor.test.js test/workerCore.test.js
git commit -m "feat: route autonomous project result statuses"
```

---

### Task 5: Dashboard and Notification Result Presentation

**Files:**
- Modify: `src/dashboard/aggregate.js`
- Modify: `src/dashboard/public/index.html`
- Modify: `src/notify.js`
- Modify: `test/aggregate.test.js`
- Modify: `test/notify.test.js`

**Interfaces:**
- Produces: dashboard task statuses `blocked` and `review` in addition to existing statuses.
- Consumes: summary fields `changes`, `validation`, `commits`, and `warnings` from NDJSON progress.
- Produces: status-aware Matrix notifications for done, failed, blocked, and review.

- [ ] **Step 1: Add aggregate and notification tests**

Create `blocked/` and `review/` fixtures and assert `collectTasks` and `statusCounts` include them. Add notification formatting assertions:

```js
ok("blocked 通知", formatNotify({ status: "blocked", rule: "禪道", source: {}, summary: "登入失效" }).startsWith("⛔"));
ok("review 通知", formatNotify({ status: "review", rule: "禪道", source: {}, summary: "部分完成" }).startsWith("⚠️"));
```

Assert `writeNotifyFile` reads the structured summary from the task log for every non-infrastructure result status.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node test/aggregate.test.js && node test/notify.test.js`

Expected: FAIL because blocked/review directories and notification labels are not supported.

- [ ] **Step 3: Implement server-side aggregation and notifications**

Add `blocked` and `review` to `STATUS_DIRS` and count both. Preserve the existing meaning of unverified `done` by reporting dashboard review count as physical `review` plus unverified `done`; calculate completed count from verified `done` only.

Use this notification map:

```js
const DISPLAY = {
  done: ["✅", "完成"],
  failed: ["❌", "失敗"],
  blocked: ["⛔", "受阻"],
  review: ["⚠️", "部分完成"],
};
```

- [ ] **Step 4: Render structured evidence in the dashboard**

Add `blocked: "受阻"` to `STATUS_LABEL` and a matching badge style. In task details render:

- `summary` as the primary result line.
- Each `changes` item under「修改／產出」.
- Each `validation` entry with passed/failed/skipped status.
- Each commit hash and message under「提交」.
- Each warning in warning color.

Allow requeue for `failed` and `blocked`; keep manual verify for successful `done`; do not relabel a physical `review` as `done`.

- [ ] **Step 5: Run focused tests and commit**

Run: `node test/aggregate.test.js && node test/notify.test.js && node test/dashboardServer.test.js`

Expected: PASS.

```bash
git add src/dashboard/aggregate.js src/dashboard/public/index.html src/notify.js test/aggregate.test.js test/notify.test.js
git commit -m "feat: present autonomous project execution results"
```

---

### Task 6: Full Verification and Live Acceptance Deployment

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Verifies the repository-wide contract and the running dashboard at `http://192.168.168.186:53000/`.

- [ ] **Step 1: Run repository verification**

Run:

```powershell
npm test
npm run test:codex-smoke
git diff --check
```

Expected: all tests pass, the live Codex smoke check completes, and `git diff --check` prints no errors.

- [ ] **Step 2: Perform a safe structured-result smoke dispatch**

Use the existing local smoke mechanism or a disposable configured project to verify a no-change success result reaches `done`, and verify malformed output reaches `failed`. Do not use the real FTL bug until the generic contract is confirmed.

- [ ] **Step 3: Restart the active element-bot runtime**

Identify the repository's documented start/restart command and active process, stop only the element-bot process tree, then start the updated runtime hidden with its existing environment and storage paths. Do not terminate unrelated Node or Codex processes.

- [ ] **Step 4: Verify the acceptance URL**

Run an HTTP request to `http://192.168.168.186:53000/api/status` and open `http://192.168.168.186:53000/`. Confirm HTTP 200, bot/worker status is visible, and the page contains the updated blocked/result UI.

- [ ] **Step 5: Confirm the deployed revision and clean worktree**

Run:

```powershell
git log -1 --oneline
git status --short
```

Expected: the latest implementation commit is shown and `git status --short` has no output. If verification exposed a defect, return to the owning task, apply its TDD cycle and commit before repeating Task 6; do not create an empty verification commit.
