# 通用自主派發與完整 Codex 輸出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 element-bot 以任務類型無關的方式派發已核准無人值守任務，並以 `status + output` 保存及顯示完整 Codex 最終說明。

**Architecture:** `taskResult.js` 集中 generic/legacy 契約與模式切換；executor 在同一次 Codex 呼叫中套用相同模式的提示詞、schema 與解析器。generic 模式將 `output` 原文寫入結果檔與 `ai_output` 日誌，Dashboard 以既有「執行輸出 (Codex)」為主要內容；舊 detailed 任務保持相容。

**Tech Stack:** Node.js 22、CommonJS、Codex CLI `--output-schema`、原生 `assert` 測試、HTML/JavaScript Dashboard。

## Global Constraints

- element-bot 是純任務派發器，不理解或列舉任務類型。
- 不檢查、猜測、搬移或修改目標專案的 instructions、skills、MCP、Git 或業務規則。
- Codex 是唯一 runtime，只有 `src/codexRunner.js` 可啟動 Codex CLI。
- 每個聊天室 command 視為已核准的無人值守任務；不得自行增加一般性的再次確認。
- 任務已經完成時回報 `success` 與證據，不重複執行。
- generic 結果固定為 `{status, output}`；狀態為 `success|failed|partial|blocked`。
- Dashboard 必須保留並主要顯示「執行輸出 (Codex)」，不得用簡短摘要取代或預設收合。
- 不使用第二次 LLM 呼叫摘要、改寫或分類結果。
- `TASK_RESULT_MODE=generic|legacy`，未設定時預設 `generic`。
- 自動測試與 smoke 不得觸發或修改正式規則指向的目標專案。

---

### Task 1: 通用結果契約與可逆模式

**Files:**
- Modify: `src/executors/taskResult.js`
- Modify: `test/taskResult.test.js`

**Interfaces:**
- Produces: `GENERIC_TASK_RESULT_SCHEMA`
- Produces: `LEGACY_TASK_RESULT_SCHEMA`
- Produces: `selectedTaskResultMode(env?) -> "generic" | "legacy"`
- Produces: `schemaForMode(mode) -> JSONSchema`
- Produces: `detectTaskResultMode(result) -> "generic" | "legacy"`
- Produces: `parseTaskResult(stdout, mode?) -> object`
- Preserves: `TASK_RESULT_SCHEMA` as legacy compatibility alias
- Preserves: `queueStatus(status)` mappings

- [ ] **Step 1: Write failing generic contract tests**

Add to `test/taskResult.test.js`:

```js
const {
  GENERIC_TASK_RESULT_SCHEMA,
  LEGACY_TASK_RESULT_SCHEMA,
  detectTaskResultMode,
  parseTaskResult,
  schemaForMode,
  selectedTaskResultMode,
} = require("../src/executors/taskResult");

const generic = { status: "success", output: "任務先前已完成，證據為外部識別碼 123。" };
assert.deepStrictEqual(parseTaskResult(JSON.stringify(generic), "generic"), generic);
ok("generic 可自動辨識", detectTaskResultMode(generic) === "generic");
ok("預設 generic", selectedTaskResultMode({}) === "generic");
ok("可切回 legacy", selectedTaskResultMode({ TASK_RESULT_MODE: "legacy" }) === "legacy");
ok("模式取得正確 schema",
  schemaForMode("generic") === GENERIC_TASK_RESULT_SCHEMA &&
  schemaForMode("legacy") === LEGACY_TASK_RESULT_SCHEMA);
assert.deepStrictEqual(GENERIC_TASK_RESULT_SCHEMA.required, ["status", "output"]);
passed++;
assert.throws(
  () => parseTaskResult(JSON.stringify({ ...generic, changes: [] }), "generic"),
  /結果回報格式錯誤/
);
passed++;
for (const status of ["failed", "partial", "blocked"]) {
  assert.deepStrictEqual(parseTaskResult(JSON.stringify({ status, output: status }), "generic"), { status, output: status });
  passed++;
}
```

- [ ] **Step 2: Run RED test**

Run: `node test/taskResult.test.js`

Expected: FAIL because generic schema and mode functions do not exist.

- [ ] **Step 3: Implement generic/legacy contract selection**

In `src/executors/taskResult.js`, rename the current schema to `LEGACY_TASK_RESULT_SCHEMA`, retain `TASK_RESULT_SCHEMA` as its alias, and add:

```js
const GENERIC_KEYS = ["status", "output"];
const GENERIC_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: RESULT_STATUSES },
    output: { type: "string", minLength: 1 },
  },
  required: GENERIC_KEYS,
  additionalProperties: false,
};

function selectedTaskResultMode(env = process.env) {
  return env.TASK_RESULT_MODE === "legacy" ? "legacy" : "generic";
}

function schemaForMode(mode) {
  return mode === "legacy" ? LEGACY_TASK_RESULT_SCHEMA : GENERIC_TASK_RESULT_SCHEMA;
}

function detectTaskResultMode(result) {
  return result && Object.prototype.hasOwnProperty.call(result, "output") ? "generic" : "legacy";
}
```

Add the generic branch before the current detailed validation body:

```js
function validateTaskResult(result, mode = detectTaskResultMode(result)) {
  if (mode === "generic") {
    assertExactKeys(result, GENERIC_KEYS, "結果");
    if (!RESULT_STATUSES.includes(result.status)) fail(`未知 status: ${result.status}`);
    if (typeof result.output !== "string" || !result.output.trim()) fail("output 不可為空");
    return result;
  }
  // Keep the current legacy exact-key, validation item, commit item, and array checks here unchanged.
  return validateLegacyTaskResult(result);
}

function parseTaskResult(stdout, mode) {
  let result;
  try { result = JSON.parse(String(stdout || "")); }
  catch (error) { fail(`不是合法 JSON (${error.message})`); }
  return validateTaskResult(result, mode || detectTaskResultMode(result));
}
```

Extract the current detailed body without changing its checks:

```js
function validateLegacyTaskResult(result) {
  assertExactKeys(result, REQUIRED_KEYS, "結果");
  if (!RESULT_STATUSES.includes(result.status)) fail(`未知 status: ${result.status}`);
  if (typeof result.summary !== "string" || !result.summary.trim()) fail("summary 不可為空");
  assertStringArray(result.changes, "changes");
  assertStringArray(result.warnings, "warnings");
  if (!Array.isArray(result.validation)) fail("validation 必須是陣列");
  for (const item of result.validation) {
    assertExactKeys(item, ["command", "status", "detail"], "validation 項目");
    if (typeof item.command !== "string" || typeof item.detail !== "string") fail("validation 文字欄位格式錯誤");
    if (!VALIDATION_STATUSES.includes(item.status)) fail(`未知 validation status: ${item.status}`);
  }
  if (!Array.isArray(result.commits)) fail("commits 必須是陣列");
  for (const item of result.commits) {
    assertExactKeys(item, ["hash", "message"], "commit 項目");
    if (typeof item.hash !== "string" || typeof item.message !== "string") fail("commit 欄位格式錯誤");
  }
  return result;
}
```

- [ ] **Step 4: Run GREEN test and full suite**

Run: `node test/taskResult.test.js; npm test`

Expected: both exit 0; all legacy tests and new generic cases pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/executors/taskResult.js test/taskResult.test.js
git commit -m "feat: add generic task output contract"
```

---

### Task 2: 無人值守提示詞與單次 Codex 執行

**Files:**
- Modify: `src/taskDefs.js`
- Modify: `src/executors/ops.js`
- Modify: `src/executors/defaultHandlers.js`
- Modify: `test/taskDefs.test.js`
- Modify: `test/defaultHandlers.test.js`
- Modify: `test/executorIntegration.test.js`

**Interfaces:**
- Consumes: `selectedTaskResultMode()`、`schemaForMode()`、`parseTaskResult()`
- Produces: `taskDef.prompt(task, { resultMode })`
- Produces: `ops.resultMode() -> "generic" | "legacy"`
- Persists: full generic `{status,output}` in `task-result.json`
- Emits: generic `ai_output` equal to `result.output`

- [ ] **Step 1: Write failing autonomous and handler tests**

In `test/taskDefs.test.js`, assert the generic prompt:

```js
const genericPrompt = getTaskDef("skill-dispatch").prompt(
  { command: "處理這項要求" },
  { resultMode: "generic" }
);
ok("generic 任務已核准", genericPrompt.includes("已核准") && genericPrompt.includes("無人值守"));
ok("不得自行等待確認", genericPrompt.includes("不得自行增加") && genericPrompt.includes("再次確認"));
ok("已完成回報成功且不重做", genericPrompt.includes("已經完成") && genericPrompt.includes("success") && genericPrompt.includes("不重複"));
ok("沒有任務類型假設", !/Git|commit|Jenkins|客服|聊天室|修改檔案/.test(genericPrompt));
```

In `test/defaultHandlers.test.js`, add a generic case:

```js
const expected = { status: "success", output: "先前已完成，無需重複操作；證據：記錄 123。" };
const emitted = [];
const h = make({
  resultMode: () => "generic",
  runCodex: async () => JSON.stringify(expected),
});
await h.ai_run({ workDir, task: TASK, emit: (o) => emitted.push(o), shared: {} });
const sum = await h.summarize({ workDir, task: TASK, emit: noop, shared: {} });
ok("generic 原樣持久化", JSON.parse(fs.readFileSync(path.join(workDir, "task-result.json"), "utf8")).output === expected.output);
ok("generic 完整輸出交給 dashboard", emitted.some((o) => o.ai_output === expected.output));
ok("沒有改動仍為 done", sum.status === "success" && sum.queueStatus === "done");
ok("generic 不捏造 produced", Array.isArray(sum.produced) && sum.produced.length === 0);
```

Update each existing detailed fixture explicitly, for example:

```js
const h = make({
  resultMode: () => "legacy",
  runCodex: async () => JSON.stringify(expected),
});
```

- [ ] **Step 2: Run RED tests**

Run: `node test/taskDefs.test.js; node test/defaultHandlers.test.js`

Expected: FAIL because prompt mode, resultMode integration, and generic `ai_output` are missing.

- [ ] **Step 3: Implement mode-aware generic prompt**

Update `src/taskDefs.js` so `prompt(task, options = {})` uses the current prompt for `legacy`; for generic it returns these task-type-neutral statements:

```js
return [
  "你正在規則指定的目標環境中執行已核准的無人值守任務。",
  "請把下方 command 視為使用者已核准交由本次流程直接執行的要求。",
  "依目標環境自己的 AGENTS.md、instructions、skills 與安全規則處理；element-bot 不介入任務如何執行或如何判定完成。",
  "不得自行增加一般性的等待使用者再次確認環節。",
  "先依目標環境規則判斷任務是否已經完成；若已完成，回報 success 與證據，不重複執行。",
  "若尚未完成，直接執行到目標環境所定義的完成點。",
  "只有缺少必要資料、外部條件不成立，或目標環境明確要求人工決策時，才回報 blocked。",
  "command：" + command,
  "依指定 schema 回報 status 與完整 output；output 應是你原本會直接回覆使用者的最終說明，不得包含秘密。",
].join("\n");
```

- [ ] **Step 4: Connect mode, schema, parsing, persistence, and display output**

In `src/executors/ops.js`:

```js
function resultMode() {
  return selectedTaskResultMode();
}

function runCodex(prompt, projectDir, mode = resultMode()) {
  return invokeCodex(prompt, {
    mode: "execute",
    cwd: projectDir,
    outputSchema: schemaForMode(mode),
  });
}
```

In `src/executors/defaultHandlers.js`, select one mode for the whole call:

```js
const mode = ops.resultMode ? ops.resultMode() : selectedTaskResultMode();
const output = await ops.runCodex(def.prompt(task, { resultMode: mode }), src, mode);
const result = parseTaskResult(output, mode);
// persist result unchanged
const displayOutput = mode === "generic" ? result.output : output;
if (typeof displayOutput === "string" && displayOutput.trim()) emit({ ai_output: displayOutput });
```

In summarize, auto-detect saved generic/legacy results, map queue status, and use `produced: Array.isArray(result.changes) ? result.changes : []`. Do not run Git or task-specific completion checks.

- [ ] **Step 5: Run focused and integration tests**

Run: `node test/taskDefs.test.js; node test/defaultHandlers.test.js; node test/executorIntegration.test.js`

Expected: all exit 0; generic no-change success maps to done, legacy remains compatible.

- [ ] **Step 6: Run full suite and commit Task 2**

Run: `npm test`

Expected: exit 0.

```powershell
git add src/taskDefs.js src/executors/ops.js src/executors/defaultHandlers.js test/taskDefs.test.js test/defaultHandlers.test.js test/executorIntegration.test.js
git commit -m "feat: run generic tasks autonomously"
```

---

### Task 3: Dashboard 與通知保留完整執行輸出

**Files:**
- Modify: `src/dashboard/public/index.html`
- Modify: `src/notify.js`
- Modify: `test/dashboardServer.test.js`
- Modify: `test/notify.test.js`

**Interfaces:**
- Consumes: generic progress summary `{status,output,...}` and `aiOutput`
- Preserves: legacy detailed summary and historical `ai_output`
- Produces: Dashboard primary label `執行輸出 (Codex)` with generic output exactly once

- [ ] **Step 1: Write failing UI and notification tests**

In `test/notify.test.js`, add a log whose final line is generic and assert notification summary uses `output`:

```js
fs.writeFileSync(path.join(q, "logs", "generic.log"),
  JSON.stringify({ status: "success", output: "已完成；外部記錄 123。" }) + "\n", "utf8");
const payload = writeNotifyFile({ queueDir: q, id: "generic", status: "done", task: { rule: "通用任務", source: {} } });
ok("generic 通知使用完整 output", payload.summary === "已完成；外部記錄 123。");
```

In `test/dashboardServer.test.js`, assert the served HTML contains generic detection and keeps the output label:

```js
ok("dashboard 保留 Codex 輸出欄", htmlText.includes("執行輸出 (Codex)"));
ok("dashboard 辨識 generic output", htmlText.includes("typeof sum.output === \"string\""));
ok("generic 不重複顯示結果文字", htmlText.includes("const isGeneric") && htmlText.includes("isGeneric ? \"\""));
```

- [ ] **Step 2: Run RED tests**

Run: `node test/notify.test.js; node test/dashboardServer.test.js`

Expected: FAIL because notifications do not read `output` and Dashboard does not detect generic summaries.

- [ ] **Step 3: Implement generic display without hiding output**

In `src/notify.js`, read `output` before legacy `summary`:

```js
if (line && typeof line.output === "string" && line.output) return line.output;
if (line && typeof line.summary === "string" && line.summary) return line.summary;
```

In `src/dashboard/public/index.html`:

```js
const isGeneric = !!(sum && typeof sum.output === "string");
const legacySumHtml = sum
  ? `<div class="k" style="margin-top:8px">結果</div><div>${esc(sum.status)} — ${esc(sum.summary || sum.message || "")}</div>` +
    ((Array.isArray(sum.needsReview) && sum.needsReview.length)
      ? sum.needsReview.map((n) => `<div style="color:#f0b072">⚠ ${esc(n)}</div>`).join("") : "") +
    changesHtml + validationHtml + commitsHtml + warningsHtml
  : "";
const sumHtml = isGeneric ? "" : legacySumHtml;
const codexOutput = prog.aiOutput || (isGeneric ? sum.output : "");
const aiHtml = codexOutput
  ? `<div class="k" style="margin-top:8px">執行輸出 (Codex)</div><pre>${esc(codexOutput)}</pre>`
  : "";
```

Keep `aiHtml` directly visible in the main detail area. Do not wrap it in `<details>`. Keep legacy changes/validation/commits/warnings rendering unchanged.

- [ ] **Step 4: Run focused UI tests and full suite**

Run: `node test/notify.test.js; node test/dashboardServer.test.js; node test/aggregate.test.js; npm test`

Expected: all exit 0; legacy and generic output are both visible.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/dashboard/public/index.html src/notify.js test/dashboardServer.test.js test/notify.test.js
git commit -m "feat: preserve full Codex task output"
```

---

### Task 4: 設定、文件、真實 smoke 與啟動驗收

**Files:**
- Modify: `.env.example`
- Modify: `docs/codex-runtime-migration.md`
- Modify: `test/codexSmoke.test.js`
- Modify: `test/runtimeMigration.test.js`

**Interfaces:**
- Consumes: `TASK_RESULT_MODE`
- Consumes: `schemaForMode("generic")` and `parseTaskResult(stdout, "generic")`
- Preserves: `TASK_RESULT_MODE=legacy` rollback path

- [ ] **Step 1: Write failing runtime documentation assertion**

In `test/runtimeMigration.test.js`, assert `.env.example` contains `TASK_RESULT_MODE=generic`, migration docs explain `legacy`, and runtime sources contain no direct launch of another agent CLI.

Run: `node test/runtimeMigration.test.js`

Expected: FAIL because mode documentation is absent.

- [ ] **Step 2: Add reversible configuration and operation docs**

Add to `.env.example`:

```dotenv
# generic=status+完整 Codex output（預設）；legacy=舊 detailed 結果格式
# TASK_RESULT_MODE=generic
```

Update `docs/codex-runtime-migration.md` with:

- generic is the default and task-type-neutral.
- `output` is shown as `執行輸出 (Codex)` without a second LLM.
- already-completed work may return success without new side effects.
- set `TASK_RESULT_MODE=legacy` and restart worker for immediate rollback.
- no target project files or skills are changed by this switch.

- [ ] **Step 3: Update real Codex smoke for no-op success**

In `test/codexSmoke.test.js`, create a marker file in its temporary directory, then call Codex once with generic schema:

```js
fs.writeFileSync(path.join(tempDir, "codex-smoke-marker.txt"), "ELEMENT_BOT_ALREADY_DONE\n", "utf8");
const output = await runCodex([
  "這是已核准的無人值守 smoke test。",
  "讀取既有 codex-smoke-marker.txt；它代表任務早已完成。",
  "不得修改、新增或刪除任何檔案。",
  "回報 success，並在 output 說明已找到 marker、無需重複操作。",
].join("\n"), {
  mode: "execute",
  cwd: tempDir,
  timeoutMs: 600000,
  outputSchema: schemaForMode("generic"),
});
const result = parseTaskResult(output, "generic");
assert.strictEqual(result.status, "success");
assert.match(result.output, /marker|無需|完成/i);
assert.deepStrictEqual(fs.readdirSync(tempDir).sort(), ["codex-smoke-marker.txt"]);
```

- [ ] **Step 4: Run all verification gates**

Run:

```powershell
git diff --check
npm test
npm run test:codex-smoke
rg -n "claude|gemini" src --glob "*.js"
```

Expected: first three commands exit 0; source scan finds no direct launch of another agent CLI. Smoke touches only its temporary directory and proves an already-completed no-op task returns `success` with useful output.

- [ ] **Step 5: Commit Task 4**

```powershell
git add .env.example docs/codex-runtime-migration.md test/codexSmoke.test.js test/runtimeMigration.test.js
git commit -m "test: verify generic autonomous Codex output"
```

- [ ] **Step 6: Restart services and verify acceptance endpoint**

Restart only these element-bot processes from `D:\GB\element-bot`:

```powershell
node src/index.js
node src/worker.js
node src/dashboard/index.js
```

Verify `http://127.0.0.1:53000/api/status` and `http://192.168.168.186:53000/api/status` return HTTP 200 with `bot_online: true`. Do not automatically enqueue a formal target-project task; the user performs that final acceptance through the monitored chat room.
