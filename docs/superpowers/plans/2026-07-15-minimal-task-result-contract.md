# Minimal Task Result Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓正式派發預設只回傳 `status + result`，保留舊詳細契約供試行回退，並讓 Dashboard 只顯示一次目標專案的自然語言結果。

**Architecture:** `taskResult.js` 集中管理 minimal/detailed 兩套格式、驗證與 queue 映射；executor 依 `TASK_RESULT_FORMAT` 選 schema，但不解讀專案內容。Dashboard 與通知同時相容兩種結果，主要畫面顯示自然語言結果，步驟及原始 JSON 收入技術詳情。

**Tech Stack:** Node.js 22、CommonJS、Codex CLI `--output-schema`、原生 assert 測試、HTML/JavaScript Dashboard。

## Global Constraints

- 任務對話、設計與文件使用繁體中文。
- 不修改任何目標專案的 AGENTS.md、instructions 或 skills。
- Element-bot 不理解 ZenTao、Git 分支策略或專案特定結果。
- `TASK_RESULT_FORMAT=minimal` 是試行預設；`detailed` 僅供快速回退。
- `success → done`、`failed → failed`、`partial → review`。
- 所有行為變更先寫失敗測試，再寫最小實作。
- 不新增第二次 LLM 呼叫。

---

### Task 1: 建立可切換的 minimal/detailed 結果契約

**Files:**
- Modify: `src/executors/taskResult.js`
- Modify: `test/taskResult.test.js`

**Interfaces:**
- Produces: `MINIMAL_TASK_RESULT_SCHEMA`、`DETAILED_TASK_RESULT_SCHEMA`
- Produces: `selectedTaskResultFormat(env?) -> "minimal" | "detailed"`
- Produces: `schemaForFormat(format) -> JSONSchema`
- Produces: `detectTaskResultFormat(result) -> "minimal" | "detailed"`
- Produces: `parseTaskResult(stdout, format?) -> object`
- Produces: `validateTaskResult(result, format?) -> object`
- Preserves: `queueStatus(status) -> "done" | "failed" | "blocked" | "review"`

- [ ] **Step 1: 先寫 minimal 格式的失敗測試**

在 `test/taskResult.test.js` 加入：

```js
const {
  MINIMAL_TASK_RESULT_SCHEMA,
  DETAILED_TASK_RESULT_SCHEMA,
  detectTaskResultFormat,
  parseTaskResult,
  queueStatus,
  schemaForFormat,
  selectedTaskResultFormat,
} = require("../src/executors/taskResult");

const minimal = { status: "success", result: "已完成過，無需再次修改。" };
assert.deepStrictEqual(parseTaskResult(JSON.stringify(minimal), "minimal"), minimal);
ok("minimal 自動辨識", detectTaskResultFormat(minimal) === "minimal");
ok("minimal schema 只要求 status/result",
  MINIMAL_TASK_RESULT_SCHEMA.required.join(",") === "status,result");
assert.throws(
  () => parseTaskResult(JSON.stringify({ ...minimal, changes: [] }), "minimal"),
  /結果回報格式錯誤/
);
passed++;
assert.throws(
  () => parseTaskResult(JSON.stringify({ status: "blocked", result: "等待" }), "minimal"),
  /結果回報格式錯誤/
);
passed++;
ok("預設 minimal", selectedTaskResultFormat({}) === "minimal");
ok("可切 detailed", selectedTaskResultFormat({ TASK_RESULT_FORMAT: "detailed" }) === "detailed");
ok("格式選到對應 schema", schemaForFormat("minimal") === MINIMAL_TASK_RESULT_SCHEMA && schemaForFormat("detailed") === DETAILED_TASK_RESULT_SCHEMA);
```

- [ ] **Step 2: 執行測試並確認因新介面不存在而失敗**

Run: `node test/taskResult.test.js`

Expected: FAIL，指出 `MINIMAL_TASK_RESULT_SCHEMA` 或 `selectedTaskResultFormat` 尚未定義。

- [ ] **Step 3: 實作兩套 schema 與自動辨識**

在 `src/executors/taskResult.js` 保留現行 schema 並更名為 `DETAILED_TASK_RESULT_SCHEMA`，新增：

```js
const MINIMAL_STATUSES = ["success", "failed", "partial"];
const MINIMAL_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: MINIMAL_STATUSES },
    result: { type: "string", minLength: 1 },
  },
  required: ["status", "result"],
  additionalProperties: false,
};

function selectedTaskResultFormat(env = process.env) {
  return env.TASK_RESULT_FORMAT === "detailed" ? "detailed" : "minimal";
}

function schemaForFormat(format) {
  return format === "detailed" ? DETAILED_TASK_RESULT_SCHEMA : MINIMAL_TASK_RESULT_SCHEMA;
}

function detectTaskResultFormat(result) {
  return result && Object.prototype.hasOwnProperty.call(result, "result") ? "minimal" : "detailed";
}
```

將 `validateTaskResult(result, format = detectTaskResultFormat(result))` 分流：minimal 嚴格檢查只有 `status/result`、狀態不得為 `blocked`、`result.trim()` 不得為空；detailed 沿用現行驗證。`parseTaskResult(stdout, format)` 解析 JSON 後呼叫該驗證器。

保留詳細格式的 `blocked → blocked` 相容映射；minimal 因 schema 不允許 `blocked`，只會產生 `done/failed/review`。

- [ ] **Step 4: 執行結果契約測試**

Run: `node test/taskResult.test.js`

Expected: PASS，包含既有 detailed 測試與新增 minimal 測試。

- [ ] **Step 5: 提交契約層**

```powershell
git add src/executors/taskResult.js test/taskResult.test.js
git commit -m "feat: add reversible minimal task result contract"
```

---

### Task 2: 派發無人值守語意並套用選定 schema

**Files:**
- Modify: `src/taskDefs.js`
- Modify: `src/executors/ops.js`
- Modify: `src/executors/defaultHandlers.js`
- Modify: `test/taskDefs.test.js`
- Modify: `test/defaultHandlers.test.js`

**Interfaces:**
- Consumes: `selectedTaskResultFormat()`、`schemaForFormat()`、`parseTaskResult()`、`validateTaskResult()`
- Produces: `ops.resultFormat() -> "minimal" | "detailed"`
- Persists: `queue/work/<id>/task-result.json`，內容保持 Codex 回傳格式

- [ ] **Step 1: 先寫派發語意與 minimal executor 的失敗測試**

在 `test/taskDefs.test.js` 驗證 prompt：

```js
const prompt = getTaskDef("skill-dispatch").prompt({ command: "https://example.com/task/1" });
ok("任務已預先核准", prompt.includes("已核准"));
ok("先判斷是否已完成", prompt.includes("先") && prompt.includes("是否已完成"));
ok("已完成不得重複修改", prompt.includes("不得重複修改"));
ok("不得等待下一輪核准", prompt.includes("不得停在計畫") && prompt.includes("等待"));
```

在 `test/defaultHandlers.test.js` 新增 minimal case：

```js
{
  const workDir = freshWork();
  const expected = { status: "success", result: "origin/live 已有 #74898 commit 5281f9e052，本次未重複修改。" };
  const h = make({
    resultFormat: () => "minimal",
    runCodex: async () => JSON.stringify(expected),
  });
  await h.ai_run({ workDir, task: TASK, emit: noop, shared: {} });
  const sum = await h.summarize({ workDir, task: TASK, emit: noop, shared: {} });
  ok("minimal 原樣保留 result", sum.result === expected.result);
  ok("minimal success 進 done", sum.queueStatus === "done");
  fs.rmSync(workDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: 執行測試確認缺少新語意與格式注入**

Run: `node test/taskDefs.test.js; node test/defaultHandlers.test.js`

Expected: FAIL，prompt 缺少「已核准」或 handler 仍以 detailed 解析 minimal。

- [ ] **Step 3: 更新通用派發 prompt**

在 `src/taskDefs.js` 使用下列通用語意，不加入目標專案專用邏輯：

```js
return [
  "你正在規則指定的目標專案中執行已核准的無人值守任務。",
  "請把下方 command 視為使用者直接在此專案提出且已核准執行的要求。",
  "先依此專案自身的 AGENTS.md、instructions 與 skills 判斷任務是否已完成。",
  "若已完成，提供專案找到的證據並回報 success，不得重複修改。",
  "若未完成，直接依專案自身流程完整執行，不得停在計畫或等待下一輪核准。",
  "無法完成時回報 failed；只有實際完成部分產出時才回報 partial。",
  "command：" + command,
  "完成後依指定 schema 回報；結果內容不得包含 token、密碼或其他秘密。",
].join("\n");
```

- [ ] **Step 4: 讓 ops 與 handler 使用同一格式**

在 `src/executors/ops.js`：

```js
const { schemaForFormat, selectedTaskResultFormat } = require("./taskResult");

function resultFormat() {
  return selectedTaskResultFormat();
}

function runCodex(prompt, projectDir) {
  const format = resultFormat();
  return invokeCodex(prompt, {
    mode: "execute",
    cwd: projectDir,
    outputSchema: schemaForFormat(format),
  });
}
```

並匯出 `resultFormat`。在 `defaultHandlers.ai_run` 以 `const format = ops.resultFormat ? ops.resultFormat() : selectedTaskResultFormat();` 呼叫 `parseTaskResult(output, format)`；`summarize` 對已保存結果使用自動辨識驗證，回傳原欄位、`queueStatus` 與 `openPath`。minimal 的 `produced` 固定為空陣列，detailed 沿用 `changes`。

- [ ] **Step 5: 執行直接相關測試**

Run: `node test/taskDefs.test.js; node test/defaultHandlers.test.js; node test/executorIntegration.test.js`

Expected: 全部 PASS。

- [ ] **Step 6: 提交派發與 executor**

```powershell
git add src/taskDefs.js src/executors/ops.js src/executors/defaultHandlers.js test/taskDefs.test.js test/defaultHandlers.test.js test/executorIntegration.test.js
git commit -m "feat: dispatch pre-approved minimal task results"
```

---

### Task 3: Dashboard 與通知只顯示一次結果

**Files:**
- Modify: `src/dashboard/public/index.html`
- Modify: `src/notify.js`
- Modify: `test/dashboardServer.test.js`
- Modify: `test/notify.test.js`

**Interfaces:**
- Consumes: progress summary 可能是 `{status,result}` 或現行 detailed object
- Preserves: `/api/tasks/<id>/progress` 原始資料，不刪除歷史 log
- Produces: 通知摘要優先使用 `result`，其次使用 `summary`

- [ ] **Step 1: 先寫相容顯示與通知的失敗測試**

在 `test/notify.test.js` 加入：

```js
{
  const q = freshQueue();
  fs.mkdirSync(path.join(q, "logs"), { recursive: true });
  fs.writeFileSync(path.join(q, "logs", "minimal.log"),
    '{"status":"success","result":"已完成過，無需再次修改"}\n', "utf8");
  const payload = writeNotifyFile({ queueDir: q, id: "minimal", status: "done", task: { rule: "日常修改", source: {} } });
  ok("minimal 通知使用 result", payload.summary === "已完成過，無需再次修改");
  fs.rmSync(q, { recursive: true, force: true });
}
```

在 `test/dashboardServer.test.js` 對首頁 HTML 加入：

```js
ok("dashboard 支援 minimal result", htmlText.includes("sum.result"));
ok("原始輸出收進技術詳情", htmlText.includes("<details") && htmlText.includes("技術詳情"));
ok("主要結果不直接串接 aiHtml", !htmlText.includes("${sumHtml}\n    ${aiHtml}${actHtml}"));
```

- [ ] **Step 2: 執行測試確認 result 尚未被讀取且技術詳情未收合**

Run: `node test/notify.test.js; node test/dashboardServer.test.js`

Expected: FAIL，通知摘要為空或 HTML 缺少技術詳情。

- [ ] **Step 3: 更新通知摘要讀取順序**

在 `src/notify.js` 的 `readSummaryFromLog` 使用：

```js
for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i];
  if (line && typeof line.result === "string" && line.result) return line.result;
  if (line && typeof line.summary === "string" && line.summary) return line.summary;
}
```

保留既有 `truncate(error, 200)`；正常結果不新增第二次 LLM 呼叫。

- [ ] **Step 4: 更新 Dashboard 主要結果與技術詳情**

在 `src/dashboard/public/index.html`：

```js
const resultText = sum && typeof sum.result === "string"
  ? sum.result
  : sum && (sum.summary || sum.message || "");
const isMinimal = !!(sum && typeof sum.result === "string");
const sumHtml = sum
  ? `<div class="k" style="margin-top:8px">結果</div><div>${esc(resultText)}</div>` +
    (isMinimal ? "" : changesHtml + validationHtml + commitsHtml + warningsHtml)
  : "";

const technicalHtml = (prog.steps.length || prog.aiOutput)
  ? `<details style="margin-top:8px"><summary class="k">技術詳情</summary>${stepsHtml}${aiHtml}</details>`
  : "";
```

主要面板改成 `${sumHtml}${technicalHtml}${actHtml}`，不再於主要結果後直接輸出 `${aiHtml}`。歷史 detailed 任務仍顯示拆解欄位，原始 JSON 收入技術詳情。

- [ ] **Step 5: 執行 UI 與通知測試**

Run: `node test/notify.test.js; node test/dashboardServer.test.js; node test/aggregate.test.js`

Expected: 全部 PASS。

- [ ] **Step 6: 提交呈現層**

```powershell
git add src/dashboard/public/index.html src/notify.js test/dashboardServer.test.js test/notify.test.js
git commit -m "feat: present task results without duplicate output"
```

---

### Task 4: 設定、文件、真實 smoke 與完整驗證

**Files:**
- Modify: `.env.example`
- Modify: `docs/codex-runtime-migration.md`
- Modify: `test/codexSmoke.test.js`
- Modify: `test/runtimeMigration.test.js`

**Interfaces:**
- Consumes: `TASK_RESULT_FORMAT`
- Consumes: `schemaForFormat("minimal")`、`parseTaskResult(stdout, "minimal")`
- Produces: `npm run test:codex-smoke` 對 minimal 真實驗證

- [ ] **Step 1: 更新 smoke test 為 minimal，先確認舊實作失敗**

在 `test/codexSmoke.test.js` 改用：

```js
const { schemaForFormat, parseTaskResult } = require("../src/executors/taskResult");

const executeOutput = await runCodex(
  [
    "在目前專案根目錄建立 codex-smoke.txt。",
    "檔案內容必須精確為 ELEMENT_BOT_CODEX_WRITE_OK（可有結尾換行）。",
    "除此之外不要建立或修改其他檔案。",
    "最後回報 success，result 用一句話說明已建立 codex-smoke.txt。",
  ].join("\n"),
  { mode: "execute", cwd: tempDir, timeoutMs: 600000, outputSchema: schemaForFormat("minimal") }
);
const result = parseTaskResult(executeOutput, "minimal");
assert.strictEqual(result.status, "success");
assert.match(result.result, /codex-smoke\.txt/);
```

Run: `npm run test:codex-smoke`

Expected: 在 Task 1 尚未實作时 FAIL；Task 1 完成後 PASS。若 Codex CLI 或登入不可用，保留完整錯誤，不改用假輸出。

- [ ] **Step 2: 補設定與操作文件**

在 `.env.example` 加入：

```dotenv
# 正式任務結果格式：minimal（status + 原始 result）或 detailed（試行回退）
# TASK_RESULT_FORMAT=minimal
```

在 `docs/codex-runtime-migration.md` 記錄預設 minimal、切換後需重啟 worker、detailed 僅供試行回退、原始 log 仍保留。

- [ ] **Step 3: 擴充靜態守門測試**

在 `test/runtimeMigration.test.js` 讀取 `.env.example`，斷言包含 `TASK_RESULT_FORMAT=minimal`，並繼續禁止目標專案固定 skill 路徑。

- [ ] **Step 4: 執行完整驗證**

Run:

```powershell
git diff --check
npm test
npm run test:codex-smoke
```

Expected: 三個命令 exit 0；完整測試全數 PASS；真實 smoke 顯示 read-only、autonomous execute、minimal structured result 通過。

- [ ] **Step 5: 提交驗證與文件**

```powershell
git add .env.example docs/codex-runtime-migration.md test/codexSmoke.test.js test/runtimeMigration.test.js
git commit -m "test: verify minimal Codex task results"
```

- [ ] **Step 6: 重啟 element-bot 服務並驗證**

只停止命令列明確包含 `D:\GB\element-bot` 的 Node 程序，再以隱藏視窗啟動：

```powershell
node src/index.js
node src/worker.js
node src/dashboard/index.js
```

驗證 `http://127.0.0.1:53000/api/status` 為 HTTP 200、`bot_online: true`，並確認 worker 啟動日誌沒有 schema 載入錯誤。正式驗收由使用者重新派發已完成任務；自動測試不得觸發 FTL 或其他正式目標專案。
