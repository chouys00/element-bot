# 真 executor + 驗證台(可中斷續跑)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 element-bot 的 dry-run executor 升級為「隔離副本 + `claude -p` 跑 skill + verify + NDJSON 回報」的真 executor,支援步驟級檢查點中斷續跑,並把監控台升級成能在畫面上驗收的驗證台。

**Architecture:** 沿用 bot / worker / dashboard 三程序檔案解耦。worker 啟動回收 `processing/` 殘留任務;agentExecutor 以 `queue/work/<id>/state.json` 檢查點驅動 `prepare→ai_run→verify→summarize` 四步,已完成步驟跳過、產物已存在則跳過 claude;每步吐 NDJSON 到 `queue/logs/<id>.log`;dashboard 讀 log 渲染進度並新增驗收/重跑/開檔動作。

**Tech Stack:** Node.js ≥22(CommonJS)、Node 內建 `fs`/`http`/`child_process`、`node:assert` 測試、`claude` CLI(headless)、Python verify 腳本(subprocess)。

**Spec:** [docs/superpowers/specs/2026-06-29-real-executor-resumable-design.md](../specs/2026-06-29-real-executor-resumable-design.md)

**測試慣例(全專案一致,每個測試檔照抄此骨架):**
```js
"use strict";
const assert = require("assert");
let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
// ... (IIFE or 同步) ...
console.log(`<name>.test.js: ${passed} 項通過 ✅`);
```
新測試檔都要加進 `package.json` 的 `test` script(見各 Task 的最後一步)。

---

## File Structure

| 檔案 | 責任 |
|------|------|
| `src/executors/checkpoint.js`(新) | 純函式:state.json 讀/寫(原子)、決定下一步、標記步驟 |
| `src/executors/agentExecutor.js`(新) | 編排四步驟 + NDJSON log + 步驟跳過 + 檢查點;低階操作可注入 |
| `src/executors/ops.js`(新) | 低階副作用:git 乾淨檢查、複製樹、跑 claude、跑 verify(供 agentExecutor 注入) |
| `src/taskDefs.js`(新) | 每個 skill 的任務定義(來源、prompt、產物、verify、needsReview) |
| `src/workerCore.js`(改) | 新增 `recoverProcessing`;`processOne` 傳 `id`/`queueDir` 給 executor |
| `src/worker.js`(改) | 啟動先 `recoverProcessing`;預設 executor 改 `agentExecutor` |
| `src/dashboard/aggregate.js`(改) | 新增 `parseProgress`(NDJSON→步驟+總結)、`isVerified` |
| `src/dashboard/server.js`(改) | 新增 GET `/api/tasks/:id/progress`;POST 驗收/重跑/開檔 |
| `src/dashboard/public/index.html`(改) | 渲染逐步進度、needsReview、驗收/重跑/開檔按鈕 |
| `config/rules.json`(改) | 第一個真實規則(防偵測 i18n) |
| `test/checkpoint.test.js`(新) | checkpoint 純函式 |
| `test/agentExecutor.test.js`(新) | 編排 + 跳過 + NDJSON |
| `test/taskDefs.test.js`(新) | 任務定義查找 |
| `test/progress.test.js`(新) | parseProgress NDJSON 解析 |
| `test/workerCore.test.js`(改) | 補 `recoverProcessing` 測試 |
| `test/dashboardServer.test.js`(改) | 補動作端點測試 |

---

## Task 1: 佇列狀態機 + 檢查點 + 啟動回收

**Files:**
- Create: `src/executors/checkpoint.js`
- Create: `test/checkpoint.test.js`
- Modify: `src/workerCore.js`
- Modify: `test/workerCore.test.js`
- Modify: `package.json`(test script)

- [ ] **Step 1: 寫 checkpoint 失敗測試**

Create `test/checkpoint.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { STEPS, initState, readState, writeState, nextStep, markStep } = require("../src/executors/checkpoint");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshWork() {
  const d = path.join(os.tmpdir(), `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

{
  const s = initState("abc");
  ok("初始所有步驟 pending", STEPS.every((k) => s.steps[k] === "pending"));
  ok("初始 nextStep 為第一步", nextStep(s) === STEPS[0]);
  ok("帶 id", s.id === "abc");
}
{
  const s = initState("abc");
  markStep(s, "prepare", "ok");
  ok("標記後跳到下一步", nextStep(s) === "ai_run");
  STEPS.forEach((k) => markStep(s, k, "ok"));
  ok("全完成 nextStep 為 null", nextStep(s) === null);
}
{
  const d = freshWork();
  ok("不存在回 null", readState(d) === null);
  const s = initState("xyz");
  writeState(d, s);
  const back = readState(d);
  ok("寫回讀得到", back && back.id === "xyz");
  ok("有 updated_at", typeof back.updated_at === "string");
  fs.writeFileSync(path.join(d, "state.json"), "{ broken", "utf8");
  ok("損毀回 null", readState(d) === null);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`checkpoint.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node test/checkpoint.test.js`
Expected: FAIL — `Cannot find module '../src/executors/checkpoint'`

- [ ] **Step 3: 實作 checkpoint.js**

Create `src/executors/checkpoint.js`:
```js
"use strict";
const fs = require("fs");
const path = require("path");

const STEPS = ["prepare", "ai_run", "verify", "summarize"];

function statePath(workDir) {
  return path.join(workDir, "state.json");
}

// 初始 state:全部步驟 pending。
function initState(id) {
  const steps = {};
  for (const k of STEPS) steps[k] = "pending";
  return { id, steps, workDir: null, attempt: 0, updated_at: new Date().toISOString() };
}

// 讀 state.json;不存在或損毀回 null(視為無檢查點 → 從頭重跑)。
function readState(workDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(workDir), "utf8"));
  } catch (_) {
    return null;
  }
}

// 原子寫:先寫 .tmp 再 rename,確保任何時點中斷都有完整檔。
function writeState(workDir, state) {
  fs.mkdirSync(workDir, { recursive: true });
  state.updated_at = new Date().toISOString();
  const tmp = statePath(workDir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, statePath(workDir));
  return state;
}

// 回傳第一個非 ok 的步驟;全部 ok 回 null。
function nextStep(state) {
  for (const k of STEPS) {
    if (!state.steps || state.steps[k] !== "ok") return k;
  }
  return null;
}

// 標記某步驟狀態(pending|ok|error)。
function markStep(state, step, status) {
  if (!state.steps) state.steps = {};
  state.steps[step] = status;
  return state;
}

module.exports = { STEPS, statePath, initState, readState, writeState, nextStep, markStep };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node test/checkpoint.test.js`
Expected: PASS — `checkpoint.test.js: N 項通過 ✅`

- [ ] **Step 5: 寫 recoverProcessing 失敗測試(擴充 workerCore.test.js)**

在 `test/workerCore.test.js` 最後 `console.log(...)` 之前,加入(並把檔頭 require 改為含 `recoverProcessing`):
```js
  // recoverProcessing:把 processing/ 殘留搬回 pending/(供啟動回收)
  {
    const q = freshQueue();
    fs.mkdirSync(path.join(q, "processing"), { recursive: true });
    fs.writeFileSync(path.join(q, "processing", "stuck.json"), JSON.stringify({ rule: "r", task: "t" }), "utf8");
    const n = recoverProcessing(q, silentLogger);
    ok("回收回傳筆數", n === 1);
    ok("已搬回 pending/", fs.existsSync(path.join(q, "pending", "stuck.json")));
    ok("processing/ 已清空", !fs.existsSync(path.join(q, "processing", "stuck.json")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // processOne 應把 id 與 queueDir 傳給 executor
  {
    const q = freshQueue();
    const f = writePending(q, "withid.json", { rule: "r", task: "t" });
    let seen = null;
    await processOne(f, { queueDir: q, executor: async (t, ctx) => { seen = ctx; }, logger: silentLogger });
    ok("executor 收到 id", seen && seen.id === "withid");
    ok("executor 收到 queueDir", seen && seen.queueDir === q);
    fs.rmSync(q, { recursive: true, force: true });
  }
```
並把第 6 行的 require 改成:
```js
const { processOne, pollOnce, recoverProcessing } = require("../src/workerCore");
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `node test/workerCore.test.js`
Expected: FAIL — `recoverProcessing is not a function`(或 `seen.id` undefined)

- [ ] **Step 7: 實作 recoverProcessing + processOne 傳 ctx**

在 `src/workerCore.js`:把 `processOne` 內呼叫 executor 的那行(`await executor(task, { logger });`)改為:
```js
    await executor(task, { logger, queueDir, id: base.replace(/\.json$/, "") });
```
在 `module.exports` 之前新增:
```js
// 啟動回收:把 processing/ 內所有殘留任務搬回 pending/。
// 對應 work/<id>/state.json 仍在,重新撿起時會從斷點續跑。同時修掉「卡 processing/」的舊問題。
function recoverProcessing(queueDir, logger) {
  const processingDir = path.join(queueDir, "processing");
  const pendingDir = path.join(queueDir, "pending");
  if (!fs.existsSync(processingDir)) return 0;
  const files = fs.readdirSync(processingDir).filter((f) => f.endsWith(".json"));
  if (files.length) fs.mkdirSync(pendingDir, { recursive: true });
  let n = 0;
  for (const f of files) {
    fs.renameSync(path.join(processingDir, f), path.join(pendingDir, f));
    logger.log(`[worker] 回收中斷任務 ${f} → pending/(將從斷點續跑)`);
    n++;
  }
  return n;
}
```
並把 `module.exports = { processOne, pollOnce };` 改成:
```js
module.exports = { processOne, pollOnce, recoverProcessing };
```

- [ ] **Step 8: 跑測試確認通過**

Run: `node test/workerCore.test.js`
Expected: PASS

- [ ] **Step 9: 把新測試檔加進 package.json**

在 `package.json` 的 `test` script 結尾(`&& node test/dashboardServer.test.js` 之後)接上:
```
 && node test/checkpoint.test.js
```

- [ ] **Step 10: 跑全部測試**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 11: Commit**

```bash
git add src/executors/checkpoint.js test/checkpoint.test.js src/workerCore.js test/workerCore.test.js package.json
git commit -m "feat: 佇列檢查點 + 啟動回收 processing/(續跑基礎)"
```

---

## Task 2: agentExecutor 編排 + NDJSON + 步驟跳過

用「可注入的假步驟處理器」驗證編排與續跑邏輯,不碰真實 claude/git。

**Files:**
- Create: `src/executors/agentExecutor.js`
- Create: `test/agentExecutor.test.js`
- Modify: `package.json`

- [ ] **Step 1: 寫 agentExecutor 失敗測試**

Create `test/agentExecutor.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { agentExecutor, readLogLines } = require("../src/executors/agentExecutor");
const { readState } = require("../src/executors/checkpoint");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const d = path.join(os.tmpdir(), `ae-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 假處理器:記錄被呼叫的步驟;summarize 回總結。
function fakeHandlers(calls) {
  return {
    prepare: async () => { calls.push("prepare"); },
    ai_run: async () => { calls.push("ai_run"); },
    verify: async () => { calls.push("verify"); },
    summarize: async () => { calls.push("summarize"); return { status: "OK", summary: "done", needsReview: ["X"], openPath: "/p" }; },
  };
}

(async () => {
  // 全新任務:四步都跑,log 有 steps 宣告 + 各步 ok + 總結
  {
    const q = freshQueue();
    const calls = [];
    await agentExecutor({ task: "t" }, { queueDir: q, id: "j1", logger: silentLogger, handlers: fakeHandlers(calls) });
    ok("四步都跑", calls.join(",") === "prepare,ai_run,verify,summarize");
    const lines = readLogLines(q, "j1");
    ok("有 steps 宣告", lines.some((o) => Array.isArray(o.steps)));
    ok("有總結 OK", lines.some((o) => o.status === "OK" && o.summary === "done"));
    const st = readState(path.join(q, "work", "j1"));
    ok("state 全 ok", st && Object.values(st.steps).every((v) => v === "ok"));
    fs.rmSync(q, { recursive: true, force: true });
  }
  // 續跑:預先把 prepare/ai_run 標 ok → 只應跑 verify/summarize
  {
    const q = freshQueue();
    const workDir = path.join(q, "work", "j2");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "state.json"),
      JSON.stringify({ id: "j2", steps: { prepare: "ok", ai_run: "ok", verify: "pending", summarize: "pending" }, attempt: 1 }), "utf8");
    const calls = [];
    await agentExecutor({ task: "t" }, { queueDir: q, id: "j2", logger: silentLogger, handlers: fakeHandlers(calls) });
    ok("只跑剩餘兩步", calls.join(",") === "verify,summarize");
    fs.rmSync(q, { recursive: true, force: true });
  }
  // 步驟丟錯:標 error 並向外丟(worker 會移 failed/)
  {
    const q = freshQueue();
    const h = fakeHandlers([]);
    h.ai_run = async () => { throw new Error("boom"); };
    let threw = false;
    try { await agentExecutor({ task: "t" }, { queueDir: q, id: "j3", logger: silentLogger, handlers: h }); }
    catch (_) { threw = true; }
    ok("有向外丟錯", threw);
    const st = readState(path.join(q, "work", "j3"));
    ok("ai_run 標 error", st && st.steps.ai_run === "error");
    const lines = readLogLines(q, "j3");
    ok("log 有 error 進度", lines.some((o) => o.step === "ai_run" && o.status === "error"));
    fs.rmSync(q, { recursive: true, force: true });
  }
  console.log(`agentExecutor.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node test/agentExecutor.test.js`
Expected: FAIL — `Cannot find module '../src/executors/agentExecutor'`

- [ ] **Step 3: 實作 agentExecutor.js**

Create `src/executors/agentExecutor.js`:
```js
"use strict";
const fs = require("fs");
const path = require("path");
const { STEPS, initState, readState, writeState, markStep } = require("./checkpoint");

const STEP_LABELS = { prepare: "準備隔離副本", ai_run: "AI 產生產物", verify: "檢查產物", summarize: "彙總結果" };

// 對 queue/logs/<id>.log append 一行 NDJSON(印完即落地)。
function appendLog(queueDir, id, obj) {
  const logsDir = path.join(queueDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(path.join(logsDir, id + ".log"), JSON.stringify(obj) + "\n", "utf8");
}

// 測試/儀表板用:讀回 log 的每行 JSON(壞行略過)。
function readLogLines(queueDir, id) {
  let raw;
  try { raw = fs.readFileSync(path.join(queueDir, "logs", id + ".log"), "utf8"); }
  catch (_) { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) {}
  }
  return out;
}

// executor 主體:依檢查點跑四步,每步吐 NDJSON;已 ok 步驟跳過;任一步丟錯→標 error 並上拋。
// ctx = { queueDir, id, logger, handlers, ops }
//  - handlers:覆寫整組步驟處理器(測試用假處理器)
//  - ops:傳給預設處理器的低階操作(Task 3 注入)
async function agentExecutor(task, ctx) {
  const { queueDir, id, logger } = ctx;
  const handlers = ctx.handlers || require("./defaultHandlers").make(ctx.ops);
  const workDir = path.join(queueDir, "work", id);

  let state = readState(workDir) || initState(id);
  state.workDir = workDir;
  state.attempt = (state.attempt || 0) + 1;
  writeState(workDir, state);

  const emit = (obj) => appendLog(queueDir, id, obj);
  emit({ steps: STEPS.map((k) => ({ key: k, label: STEP_LABELS[k] })) });

  const shared = { id, produced: [], verify: null };
  let summary = null;

  for (const step of STEPS) {
    if (state.steps[step] === "ok") { emit({ step, status: "ok", note: "略過(已完成)" }); continue; }
    emit({ step, status: "run" });
    const t0 = Date.now();
    try {
      const r = await handlers[step]({ workDir, task, emit, logger, shared });
      if (step === "summarize") summary = r;
      markStep(state, step, "ok");
      writeState(workDir, state);
      emit({ step, status: "ok", ms: Date.now() - t0 });
    } catch (err) {
      markStep(state, step, "error");
      writeState(workDir, state);
      emit({ step, status: "error", ms: Date.now() - t0, note: String((err && err.message) || err) });
      throw err; // worker 會移到 failed/;state.json 留著供重跑續跑
    }
  }
  if (summary) emit(summary);
}

module.exports = { agentExecutor, appendLog, readLogLines, STEP_LABELS };
```

> 註:`require("./defaultHandlers")` 在 Task 3 才建立。Task 2 的測試一律走 `ctx.handlers`(假處理器),不會觸發該 require,故此時測試可獨立通過。

- [ ] **Step 4: 跑測試確認通過**

Run: `node test/agentExecutor.test.js`
Expected: PASS

- [ ] **Step 5: 把新測試檔加進 package.json**

`test` script 結尾接上:
```
 && node test/agentExecutor.test.js
```

- [ ] **Step 6: 跑全部測試**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/executors/agentExecutor.js test/agentExecutor.test.js package.json
git commit -m "feat: agentExecutor 編排四步驟 + NDJSON 進度 + 步驟跳過續跑"
```

---

## Task 3: 真實步驟處理器 + 任務定義 + 接上 worker

實作隔離副本(git 安全網)、`claude -p`、verify,低階操作可注入以利測試。

**Files:**
- Create: `src/executors/ops.js`
- Create: `src/executors/defaultHandlers.js`
- Create: `src/taskDefs.js`
- Create: `test/taskDefs.test.js`
- Create: `test/defaultHandlers.test.js`
- Modify: `src/worker.js`
- Modify: `config/rules.json`
- Modify: `package.json`

- [ ] **Step 1: 寫 taskDefs 失敗測試**

Create `test/taskDefs.test.js`:
```js
"use strict";
const assert = require("assert");
const { getTaskDef } = require("../src/taskDefs");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

{
  const def = getTaskDef("i18n-skill");
  ok("找得到 i18n-skill", !!def);
  ok("有 sourceDir 函式", typeof def.sourceDir === "function");
  ok("有 prompt 函式", typeof def.prompt === "function");
  ok("有 artifacts 陣列", Array.isArray(def.artifacts));
  ok("prompt 含站點目錄指示", def.prompt({ params: { 站點: "siteA" } }).includes("當前工作目錄"));
}
{
  let threw = false;
  try { getTaskDef("不存在"); } catch (_) { threw = true; }
  ok("查無定義丟錯", threw);
}

console.log(`taskDefs.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node test/taskDefs.test.js`
Expected: FAIL — `Cannot find module '../src/taskDefs'`

- [ ] **Step 3: 實作 taskDefs.js**

Create `src/taskDefs.js`:
```js
"use strict";
const path = require("path");

// 每個 skill 一筆任務定義。新增 skill = 在此加一筆,不動 worker/bot/dashboard。
// 介面:
//   sourceDir(task) -> 來源站點絕對路徑(會被複製成隔離副本)
//   prompt(task)    -> 餵給 claude -p 的無人值守指示
//   artifacts       -> 預期產物(相對 copy 根);全部存在則 ai_run 跳過 claude
//   verifyArgs(copyDir) -> ["py","-3",script,copyDir,locale] 之類;null=不 verify
//   needsReview     -> 完成後要人補/核對的提示
const FTL_ROOT = process.env.NSL_FTL_ROOT || "D:/ftl/ftl/ftl";
const I18N_SKILL_DIR = process.env.NSL_SKILL_DIR || path.join(FTL_ROOT, ".cursor/skills/template-i18n-inject");

const DEFS = {
  "i18n-skill": {
    sourceDir: (task) => path.join(FTL_ROOT, String((task.params && task.params["站點"]) || "")),
    prompt: () => [
      "你是無人值守的自動執行者,必須全自動完成,禁止發問或停下來等待確認。",
      "所有原需使用者確認/Plan 同意/對照表確認/dry-run 確認的環節,一律自動採用文件建議做法並續行。",
      "站點目錄就是你的當前工作目錄,所有產出與修改只能發生在此目錄(及其子目錄)內。",
      "請完整讀取並嚴格遵照 " + I18N_SKILL_DIR + "/SKILL.md 及其 reference/ 全部,",
      "依 SKILL.md 自行判斷單/多語系,把中文文案轉成 data-i18n 標記、產生 i18n/<語系>.json。",
      "安全紅線:只准讀寫當前工作目錄(及其子目錄);不可修改當前目錄以外任何檔案。產完翻譯檔即可,不需自行 verify。",
    ].join(""),
    artifacts: ["i18n/zh_CN.json"],
    verifyArgs: (copyDir) => [process.env.NSL_PY || "py", "-3", path.join(I18N_SKILL_DIR, "scripts", "verify_i18n.py"), copyDir, "zh_CN"],
    needsReview: ["請人工核對文案正確性(verify 只驗結構不驗文意)", "套用到正式站前再次確認"],
  },
};

function getTaskDef(name) {
  const def = DEFS[name];
  if (!def) throw new Error("查無任務定義:" + name);
  return def;
}

module.exports = { getTaskDef, DEFS };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node test/taskDefs.test.js`
Expected: PASS

- [ ] **Step 5: 寫 defaultHandlers 失敗測試(注入假 ops)**

Create `test/defaultHandlers.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { make } = require("../src/executors/defaultHandlers");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshWork() {
  const d = path.join(os.tmpdir(), `dh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(d, "copy"), { recursive: true });
  return d;
}
const noop = () => {};

(async () => {
  // ai_run:產物已存在 → 不呼叫 claude
  {
    const workDir = freshWork();
    fs.mkdirSync(path.join(workDir, "copy", "i18n"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "copy", "i18n", "zh_CN.json"), "{}", "utf8");
    let claudeCalled = false;
    const ops = { gitClean: () => {}, copyTree: () => {}, runClaude: () => { claudeCalled = true; }, runVerify: () => ({ errors: 0, warnings: 0 }) };
    const h = make(ops);
    await h.ai_run({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: {} });
    ok("產物已存在不跑 claude", claudeCalled === false);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  // ai_run:產物不存在 → 呼叫 claude
  {
    const workDir = freshWork();
    let claudeCalled = false;
    const ops = { gitClean: () => {}, copyTree: () => {}, runClaude: () => { claudeCalled = true; }, runVerify: () => ({ errors: 0, warnings: 0 }) };
    const h = make(ops);
    await h.ai_run({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: {} });
    ok("產物缺則跑 claude", claudeCalled === true);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  // verify errors>0 → summarize 回 NEEDS;errors=0 → OK
  {
    const workDir = freshWork();
    fs.mkdirSync(path.join(workDir, "copy", "i18n"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "copy", "i18n", "zh_CN.json"), "{}", "utf8");
    const shared = {};
    const okOps = { gitClean: () => {}, copyTree: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 0, warnings: 1 }) };
    let h = make(okOps);
    await h.verify({ workDir, task: { task: "i18n-skill" }, emit: noop, shared });
    let sum = await h.summarize({ workDir, task: { task: "i18n-skill" }, emit: noop, shared });
    ok("errors=0 → OK", sum.status === "OK" && Array.isArray(sum.needsReview));

    const badOps = { gitClean: () => {}, copyTree: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 3, warnings: 0 }) };
    const shared2 = {};
    h = make(badOps);
    await h.verify({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: shared2 });
    sum = await h.summarize({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: shared2 });
    ok("errors>0 → NEEDS", sum.status === "NEEDS");
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  // prepare:呼叫 gitClean 再 copyTree
  {
    const workDir = freshWork();
    const order = [];
    const ops = { gitClean: () => order.push("git"), copyTree: () => order.push("copy"), runClaude: () => {}, runVerify: () => ({ errors: 0 }) };
    const h = make(ops);
    await h.prepare({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: {} });
    ok("prepare 先 git 再 copy", order.join(",") === "git,copy");
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`defaultHandlers.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `node test/defaultHandlers.test.js`
Expected: FAIL — `Cannot find module '../src/executors/defaultHandlers'`

- [ ] **Step 7: 實作 ops.js(真實低階操作)**

Create `src/executors/ops.js`:
```js
"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");

// 來源須在 git 控制下且無未提交改動(改檔任務的安全網)。
function gitClean(srcDir) {
  const r = spawnSync("git", ["status", "--porcelain", "."], { cwd: srcDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("來源不在 git 控制下,缺安全網:" + srcDir);
  if ((r.stdout || "").trim()) throw new Error("來源有未提交改動,請先 commit/還原:" + srcDir);
}

// 複製整棵樹到隔離副本(先清空目的地)。
function copyTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) throw new Error("找不到來源:" + srcDir);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
}

// 在隔離副本內跑 headless claude;非零 exit 丟錯。
function runClaude(prompt, copyDir) {
  const r = spawnSync("claude", ["--dangerously-skip-permissions", "-p", prompt], {
    cwd: copyDir, encoding: "utf8",
    shell: process.platform === "win32",
    timeout: parseInt(process.env.AI_TIMEOUT_MS || "1800000", 10),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error("claude 失敗:" + String(r.stderr || "").slice(0, 200));
}

// 跑 verify 腳本,從輸出解析 errors=/warnings=。
function runVerify(args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const text = String(r.stdout || "") + "\n" + String(r.stderr || "");
  const m = text.match(/errors=(\d+),\s*warnings=(\d+)/);
  return { errors: m ? parseInt(m[1], 10) : 0, warnings: m ? parseInt(m[2], 10) : 0 };
}

module.exports = { gitClean, copyTree, runClaude, runVerify };
```

- [ ] **Step 8: 實作 defaultHandlers.js**

Create `src/executors/defaultHandlers.js`:
```js
"use strict";
const fs = require("fs");
const path = require("path");
const { getTaskDef } = require("../taskDefs");

// 用注入的 ops 組出四個真實步驟處理器。ops 預設為真實副作用,測試可傳假的。
function make(ops) {
  ops = ops || require("./ops");

  function copyDirOf(workDir) { return path.join(workDir, "copy"); }

  return {
    async prepare({ workDir, task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      ops.gitClean(src);
      ops.copyTree(src, copyDirOf(workDir));
      emit({ step: "prepare", status: "run", note: "已建立隔離副本" });
    },

    async ai_run({ workDir, task, emit }) {
      const def = getTaskDef(task.task);
      const copyDir = copyDirOf(workDir);
      const artifacts = def.artifacts || [];
      const allExist = artifacts.length > 0 && artifacts.every((a) => fs.existsSync(path.join(copyDir, a)));
      if (allExist) { emit({ step: "ai_run", status: "run", note: "產物已存在,跳過 claude(省額度)" }); return; }
      ops.runClaude(def.prompt(task), copyDir);
    },

    async verify({ workDir, task, shared }) {
      const def = getTaskDef(task.task);
      if (!def.verifyArgs) { shared.verify = { errors: 0, warnings: 0 }; return; }
      shared.verify = ops.runVerify(def.verifyArgs(copyDirOf(workDir)));
    },

    async summarize({ workDir, task, shared }) {
      const def = getTaskDef(task.task);
      const copyDir = copyDirOf(workDir);
      const produced = (def.artifacts || []).filter((a) => fs.existsSync(path.join(copyDir, a)));
      if (!produced.length) return { status: "ERROR", message: "未產出任何產物", openPath: copyDir };
      const v = shared.verify || { errors: 0 };
      if (v.errors > 0) return { status: "NEEDS", summary: `產出但 verify 有缺:errors=${v.errors}`, produced, openPath: copyDir };
      return { status: "OK", summary: `產出 ${produced.join(", ")},verify errors=0`, needsReview: def.needsReview || [], produced, openPath: copyDir };
    },
  };
}

module.exports = { make };
```

- [ ] **Step 9: 跑兩個測試確認通過**

Run: `node test/defaultHandlers.test.js && node test/taskDefs.test.js`
Expected: 兩個都 PASS

- [ ] **Step 10: 接上 worker(預設 executor 改 agentExecutor + 啟動回收)**

在 `src/worker.js`:把
```js
const { dryRunExecutor } = require("./executors/dryRun");
```
改為
```js
const { agentExecutor } = require("./executors/agentExecutor");
const { recoverProcessing } = require("./workerCore");
```
把
```js
const deps = { queueDir: config.queueDir, executor: dryRunExecutor, logger };
```
改為
```js
const deps = { queueDir: config.queueDir, executor: agentExecutor, logger };
recoverProcessing(config.queueDir, logger);
```
(`recoverProcessing` 放在 `logger.log("[worker] 啟動...")` 之後、`loop()` 之前。)

> `pollOnce`/`processOne` 既有的 `require("./workerCore")` 不變;`worker.js` 此處同檔再引入 `recoverProcessing` 即可。

- [ ] **Step 11: 設定第一個真實規則**

把 `config/rules.json` 改為(保留既有範例亦可,這裡新增 i18n 規則):
```json
[
  {
    "name": "防偵測i18n",
    "keywords": ["防偵測", "i18n", "翻譯檔"],
    "task": "i18n-skill",
    "use_llm": true,
    "intent": "有人要求對某站點做防偵測 / 產生 i18n 翻譯檔時才觸發;單純討論或回顧則不要",
    "extract": ["站點"]
  }
]
```

- [ ] **Step 12: 把新測試檔加進 package.json**

`test` script 結尾接上:
```
 && node test/taskDefs.test.js && node test/defaultHandlers.test.js
```

- [ ] **Step 13: 跑全部測試**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 14: Commit**

```bash
git add src/executors/ops.js src/executors/defaultHandlers.js src/taskDefs.js test/taskDefs.test.js test/defaultHandlers.test.js src/worker.js config/rules.json package.json
git commit -m "feat: 真實步驟處理器(隔離副本+claude -p+verify)+ 任務定義 + 接上 worker"
```

- [ ] **Step 15:(人工)端到端驗證 — 改檔任務不傷正本**

前置:`.env` 設好 Matrix;確認 `NSL_FTL_ROOT` 下有一個 git 乾淨的測試站(如 `siteA`)。
1. 開三個終端:`npm start`(bot)、`npm run worker`、`npm run dashboard`。
2. 到受監聽房間發:「幫 siteA 做防偵測 i18n」。
3. 觀察 `queue/work/<id>/copy/` 出現副本與 `i18n/zh_CN.json`。
4. 對正本做雜湊比對,確認**零改動**:
   Run: `git -C "%NSL_FTL_ROOT%/siteA" status --porcelain`
   Expected: 空輸出(正本未被動到)。
5. 確認 `queue/logs/<id>.log` 末行為 `{"status":"OK",...}` 或 `{"status":"NEEDS",...}`。

---

## Task 4: 監控台渲染逐步進度 + needsReview

**Files:**
- Modify: `src/dashboard/aggregate.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/public/index.html`
- Create: `test/progress.test.js`
- Modify: `package.json`

- [ ] **Step 1: 寫 parseProgress 失敗測試**

Create `test/progress.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseProgress } = require("../src/dashboard/aggregate");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshQueue() {
  const d = path.join(os.tmpdir(), `pg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(d, "logs"), { recursive: true });
  return d;
}
function writeLog(q, id, lines) {
  fs.writeFileSync(path.join(q, "logs", id + ".log"), lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
}

{
  const q = freshQueue();
  writeLog(q, "j1", [
    { steps: [{ key: "prepare", label: "準備隔離副本" }, { key: "ai_run", label: "AI 產生產物" }] },
    { step: "prepare", status: "run" },
    { step: "prepare", status: "ok", ms: 120 },
    { step: "ai_run", status: "run" },
    { step: "ai_run", status: "error", ms: 50, note: "boom" },
  ]);
  const p = parseProgress(q, "j1");
  ok("解析出兩步", p.steps.length === 2);
  ok("prepare 取最後狀態 ok", p.steps[0].status === "ok" && p.steps[0].ms === 120);
  ok("ai_run 取最後狀態 error", p.steps[1].status === "error" && p.steps[1].note === "boom");
  ok("尚無總結", p.summary === null);
  fs.rmSync(q, { recursive: true, force: true });
}
{
  const q = freshQueue();
  writeLog(q, "j2", [
    { steps: [{ key: "summarize", label: "彙總結果" }] },
    { step: "summarize", status: "ok", ms: 5 },
    { status: "OK", summary: "好了", needsReview: ["補設計"], openPath: "/x" },
  ]);
  const p = parseProgress(q, "j2");
  ok("取到總結", p.summary && p.summary.status === "OK");
  ok("needsReview 帶出", p.summary.needsReview[0] === "補設計");
  fs.rmSync(q, { recursive: true, force: true });
}
{
  const q = freshQueue();
  const p = parseProgress(q, "none");
  ok("無 log 回空進度", p.steps.length === 0 && p.summary === null);
  fs.rmSync(q, { recursive: true, force: true });
}

console.log(`progress.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node test/progress.test.js`
Expected: FAIL — `parseProgress is not a function`

- [ ] **Step 3: 實作 parseProgress(加進 aggregate.js)**

在 `src/dashboard/aggregate.js` 的 `module.exports` 之前新增:
```js
// 解析 queue/logs/<id>.log 的 NDJSON → { steps:[{key,label,status,ms,note}], summary|null }。
// 同一 step 多行取最新;summary 取最後一個有頂層 status 的物件。
function parseProgress(queueDir, id) {
  let raw;
  try { raw = fs.readFileSync(path.join(queueDir, "logs", id + ".log"), "utf8"); }
  catch (_) { return { steps: [], summary: null }; }

  const order = [];
  const byKey = {};
  let summary = null;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch (_) { continue; }
    if (Array.isArray(o.steps)) {
      for (const st of o.steps) {
        if (!byKey[st.key]) { byKey[st.key] = { key: st.key, label: st.label, status: "pending" }; order.push(st.key); }
        else byKey[st.key].label = st.label;
      }
    } else if (o.step) {
      if (!byKey[o.step]) { byKey[o.step] = { key: o.step, label: o.step, status: "pending" }; order.push(o.step); }
      byKey[o.step].status = o.status;
      if (o.ms != null) byKey[o.step].ms = o.ms;
      if (o.note != null) byKey[o.step].note = o.note;
    } else if (typeof o.status === "string") {
      summary = o;
    }
  }
  return { steps: order.map((k) => byKey[k]), summary };
}
```
並把 `module.exports = { ... }` 末尾加入 `parseProgress`:
```js
module.exports = { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, parseProgress, STATUS_DIRS };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node test/progress.test.js`
Expected: PASS

- [ ] **Step 5: server 加 /api/tasks/:id/progress 路由**

在 `src/dashboard/server.js`:檔頭 require 補 `parseProgress`:
```js
const { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, parseProgress } = require("./aggregate");
```
在既有 `logMatch` 區塊之後、`/api/messages` 之前新增:
```js
      const progMatch = p.match(/^\/api\/tasks\/([^/]+)\/progress$/);
      if (progMatch) {
        const id = decodeURIComponent(progMatch[1]);
        if (id.includes("..") || id.includes("/") || id.includes("\\")) {
          res.writeHead(400); return res.end("bad id");
        }
        return sendJson(res, 200, parseProgress(queueDir, id));
      }
```

- [ ] **Step 6: 前端渲染逐步進度 + needsReview**

在 `src/dashboard/public/index.html` 的 `<script>` 內:
(a) 把 `renderDetail` 改為同時抓 progress 並渲染步驟與 needsReview。將原 `renderDetail` 整個函式替換為:
```js
function stepIcon(s) { return s === "ok" ? "✓" : s === "run" ? "⏳" : s === "error" ? "✗" : s === "stop" ? "⚠" : "○"; }
function stepColor(s) { return s === "ok" ? "#7ee787" : s === "run" ? "#58a6ff" : (s === "error" || s === "stop") ? "#ff9d96" : "#586069"; }

async function renderDetail() {
  const t = lastTasks.find((x) => x.id === selectedId);
  const box = document.getElementById("detail");
  if (!t) { box.innerHTML = `<span class="muted">任務已不在列表中。</span>`; return; }
  let prog = { steps: [], summary: null };
  try { prog = await fetch(`/api/tasks/${encodeURIComponent(selectedId)}/progress`).then((r) => r.json()); } catch (_) {}

  const stepsHtml = prog.steps.length
    ? `<div class="k" style="margin-top:8px">步驟</div>` + prog.steps.map((s) =>
        `<div style="color:${stepColor(s.status)}">${stepIcon(s.status)} ${esc(s.label)}` +
        (s.ms != null ? ` <span class="muted">${(s.ms / 1000).toFixed(1)}s</span>` : (s.note ? ` <span class="muted">${esc(s.note)}</span>` : "")) +
        `</div>`).join("")
    : "";

  const sum = prog.summary;
  const sumHtml = sum
    ? `<div class="k" style="margin-top:8px">結果</div><div>${esc(sum.status)} — ${esc(sum.summary || sum.message || "")}</div>` +
      ((sum.needsReview && sum.needsReview.length)
        ? sum.needsReview.map((n) => `<div style="color:#f0b072">⚠ ${esc(n)}</div>`).join("") : "")
    : "";

  box.innerHTML = `
    <div><span class="k">狀態</span> ${badge(t.status)}</div>
    <div><span class="k">聊天室</span> ${esc(t.room_name)}</div>
    <div><span class="k">發送者</span> ${esc(t.sender)}</div>
    <div><span class="k">規則</span> ${esc(t.rule)} → ${esc(t.task)}</div>
    <div><span class="k">來源訊息</span> ${esc(t.body)}</div>
    ${stepsHtml}
    ${sumHtml}`;
}
```
(b) 既有的 `selectTask`、輪詢 `refresh` 不變(`renderDetail` 會在選取時被呼叫)。

- [ ] **Step 7: 把新測試檔加進 package.json**

`test` script 結尾接上:
```
 && node test/progress.test.js
```

- [ ] **Step 8: 跑全部測試**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 9:(人工)畫面驗證**

1. `npm run dashboard`,瀏覽器開 `http://127.0.0.1:3000`。
2. 觸發一個任務(或用 Task 3 Step 15 的流程),點該任務。
3. 右側詳情應**即時**顯示 prepare→ai_run→verify→summarize 的 ⏳/✓/✗ 與秒數,完成後顯示結果與 ⚠ needsReview。

- [ ] **Step 10: Commit**

```bash
git add src/dashboard/aggregate.js src/dashboard/server.js src/dashboard/public/index.html test/progress.test.js package.json
git commit -m "feat: 監控台渲染逐步 NDJSON 進度 + needsReview"
```

---

## Task 5: 監控台驗收動作(開檔 / 驗收 / 重跑)

**Files:**
- Modify: `src/dashboard/aggregate.js`(verified 標記查詢)
- Modify: `src/dashboard/server.js`(POST 動作端點)
- Modify: `src/dashboard/public/index.html`(動作按鈕)
- Modify: `test/dashboardServer.test.js`
- (沿用既有 package.json test 條目)

- [ ] **Step 1: 看既有 server 測試風格**

Run: `node test/dashboardServer.test.js`
Expected: 既有測試 PASS(先確認綠燈,作為修改基準)。

- [ ] **Step 2: 寫動作端點失敗測試(擴充 dashboardServer.test.js)**

在 `test/dashboardServer.test.js` 既有測試結尾、`console.log(...)` 之前新增(沿用該檔既有的 `createServer`/啟動 helper;以下用 Node 內建 `http` 對伺服器發請求。若該檔已有發請求 helper 就改用它):
```js
  // requeue:failed/<id>.json → pending/<id>.json
  {
    const { root, queueDir, base } = freshServerRoot(); // 既有 helper;若無則見下方說明自行建立
    fs.mkdirSync(path.join(queueDir, "failed"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "failed", "r1.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
    const res = await post(base, "/api/tasks/r1/requeue");
    ok("requeue 回 200", res.status === 200);
    ok("已移回 pending/", fs.existsSync(path.join(queueDir, "pending", "r1.json")));
    ok("failed/ 已無", !fs.existsSync(path.join(queueDir, "failed", "r1.json")));
    cleanup(root);
  }
  // verify(驗收):寫 work/<id>/verified.json
  {
    const { root, queueDir, base } = freshServerRoot();
    const res = await post(base, "/api/tasks/v1/verify");
    ok("verify 回 200", res.status === 200);
    ok("有 verified 標記", fs.existsSync(path.join(queueDir, "work", "v1", "verified.json")));
    cleanup(root);
  }
  // 防穿越:id 帶 .. 應 400
  {
    const { root, base } = freshServerRoot();
    const res = await post(base, "/api/tasks/%2e%2e%2fx/requeue");
    ok("穿越 id 擋下", res.status === 400);
    cleanup(root);
  }
```
> 若 `test/dashboardServer.test.js` 尚無 `freshServerRoot`/`post`/`cleanup` helper,於檔案上方加入:
```js
const http = require("http");
function freshServerRoot() {
  const root = path.join(os.tmpdir(), `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const queueDir = path.join(root, "queue");
  for (const s of ["pending", "processing", "done", "failed", "logs", "work"]) fs.mkdirSync(path.join(queueDir, s), { recursive: true });
  const storageDir = path.join(root, "storage"); fs.mkdirSync(storageDir, { recursive: true });
  const outputFile = path.join(root, "output", "messages.jsonl"); fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const srv = createServer({ queueDir, storageDir, outputFile });
  srv.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { root, queueDir, storageDir, base, srv };
}
function post(base, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, { method: "POST" }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject); req.end();
  });
}
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }
```
(注意:`freshServerRoot` 回傳的 `srv` 在 `cleanup` 前可 `srv.close()`;若既有測試以單一 server 實例運作,改用既有模式即可。)

- [ ] **Step 3: 跑測試確認失敗**

Run: `node test/dashboardServer.test.js`
Expected: FAIL — 動作端點回 404(尚未實作)

- [ ] **Step 4: 實作 POST 動作端點(server.js)**

在 `src/dashboard/server.js` 的 `createServer` handler 內,**最前面**(`const p = new URL(...)` 之後)新增 POST 分支。先加一個共用的 id 防穿越函式於檔案上方:
```js
function safeId(id) { return !(id.includes("..") || id.includes("/") || id.includes("\\")); }
```
在 `try {` 之後、現有 `if (p === "/api/tasks")` 之前插入:
```js
      if (req.method === "POST") {
        const m = p.match(/^\/api\/tasks\/([^/]+)\/(requeue|verify)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (!safeId(id)) { res.writeHead(400); return res.end("bad id"); }
          if (m[2] === "requeue") {
            const from = path.join(queueDir, "failed", id + ".json");
            const to = path.join(queueDir, "pending", id + ".json");
            if (!fs.existsSync(from)) { res.writeHead(404); return res.end("no failed task"); }
            fs.mkdirSync(path.join(queueDir, "pending"), { recursive: true });
            // 一併清掉舊的 error 旁檔,讓重跑乾淨
            try { fs.rmSync(path.join(queueDir, "failed", id + ".json.error.txt"), { force: true }); } catch (_) {}
            fs.renameSync(from, to);
            return sendJson(res, 200, { ok: true });
          }
          // verify:寫驗收標記
          const workDir = path.join(queueDir, "work", id);
          fs.mkdirSync(workDir, { recursive: true });
          fs.writeFileSync(path.join(workDir, "verified.json"), JSON.stringify({ verified_at: new Date().toISOString() }), "utf8");
          return sendJson(res, 200, { ok: true });
        }
        res.writeHead(404); return res.end("not found");
      }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node test/dashboardServer.test.js`
Expected: PASS

- [ ] **Step 6: aggregate 提供 verified 查詢 + collectTasks 帶出**

在 `src/dashboard/aggregate.js` 新增純函式並在 `collectTasks` 的每筆 `out.push({...})` 物件內補 `verified` 欄位:
```js
// 任務是否已被人工驗收(work/<id>/verified.json 存在)。
function isVerified(queueDir, id) {
  return fs.existsSync(path.join(queueDir, "work", id, "verified.json"));
}
```
在 `collectTasks` 內 `out.push({ ... })` 物件結尾(`enqueued_at: task.enqueued_at,` 之後)加:
```js
        verified: isVerified(queueDir, id),
```
並把 `module.exports` 補上 `isVerified`。

- [ ] **Step 7: 前端加動作按鈕**

在 `src/dashboard/public/index.html` 的 `renderDetail`(Task 4 版本)的 `box.innerHTML` 模板**結尾**加入動作列,並在設定 innerHTML 後綁定事件。把 `box.innerHTML = \`...\`;` 之後接上:
```js
  const actHtml = `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
    ${sum && sum.openPath ? `<button data-act="open" class="abtn">開啟產物</button>` : ""}
    ${t.status === "done" ? `<button data-act="verify" class="abtn">${t.verified ? "✓ 已驗收" : "✓ 驗收完成"}</button>` : ""}
    ${t.status === "failed" ? `<button data-act="requeue" class="abtn">重跑</button>` : ""}
  </div>`;
  box.insertAdjacentHTML("beforeend", actHtml);
  box.querySelectorAll(".abtn").forEach((b) => b.addEventListener("click", () => doAction(b.dataset.act, sum)));
```
在 `<script>` 內新增動作處理與最小按鈕樣式(樣式加進 `<style>`):
```js
async function doAction(act, sum) {
  if (act === "open") {
    if (sum && sum.openPath) { await fetch(`/api/tasks/${encodeURIComponent(selectedId)}/open`, { method: "POST" }).catch(() => {}); }
    return;
  }
  await fetch(`/api/tasks/${encodeURIComponent(selectedId)}/${act}`, { method: "POST" }).catch(() => {});
  refresh();
}
```
`<style>` 內加:
```css
  .abtn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .abtn:hover { border-color: #58a6ff; color: #79b8ff; }
```

- [ ] **Step 8: 實作 open 端點(server.js)**

在 Task 5 Step 4 的 POST 區塊內,`const m = p.match(...)` 的正則改為涵蓋 `open`:
```js
        const m = p.match(/^\/api\/tasks\/([^/]+)\/(requeue|verify|open)$/);
```
並在 `verify` 標記那段之前加入 `open` 分支:
```js
          if (m[2] === "open") {
            const prog = parseProgress(queueDir, id);
            const openPath = prog.summary && prog.summary.openPath;
            const workRoot = path.join(queueDir, "work");
            const resolved = openPath ? path.resolve(openPath) : "";
            // 只允許開啟佇列 work/ 內的路徑(防穿越)
            if (!resolved || !(resolved === path.resolve(workRoot) || resolved.startsWith(path.resolve(workRoot) + path.sep))) {
              res.writeHead(400); return res.end("bad path");
            }
            const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
            require("child_process").spawn(opener, [resolved], { detached: true, stdio: "ignore" }).unref();
            return sendJson(res, 200, { ok: true });
          }
```

- [ ] **Step 9: 跑全部測試**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 10:(人工)驗收動作驗證**

1. `npm run dashboard`;選一個 `done` 任務 → 按「開啟產物」應開檔案總管到 `queue/work/<id>/copy`。
2. 按「驗收完成」→ 重新整理後按鈕變「✓ 已驗收」。
3. 選一個 `failed` 任務 → 按「重跑」→ 任務回到 pending,worker 接手後**從斷點續跑**(state.json 仍在),完成度只補未完成步驟。

- [ ] **Step 11: Commit**

```bash
git add src/dashboard/aggregate.js src/dashboard/server.js src/dashboard/public/index.html test/dashboardServer.test.js
git commit -m "feat: 監控台驗收動作(開檔/驗收/重跑,重跑自動續跑)"
```

---

## 完成後的整體驗證(端到端閉環)

1. `.env` 設好 Matrix;`NSL_FTL_ROOT` 下備一個 git 乾淨測試站。
2. 開 `npm start` / `npm run worker` / `npm run dashboard`。
3. 受監聽房間發「幫 <站> 做防偵測 i18n」。
4. 瀏覽器 `http://127.0.0.1:3000` 看任務即時跑過四步;完成顯示結果 + ⚠ needsReview。
5. **中斷續跑**:任務跑到 ai_run 時 `Ctrl+C` 砍掉 worker;重啟 `npm run worker` → 該任務從 processing 回收、跳過已完成步驟、ai_run 因產物已在而跳過 claude、續完 verify/summarize。
6. 按「開啟產物」看翻譯檔;對正本 `git status` 確認**零改動**;按「驗收完成」。

達成:「群裡發一句 → 自動隔離跑 skill → 畫面看進度 → 中斷可續 → 開檔驗收」。

---

## Self-Review(計劃對照 spec)

- **真 executor(隔離+claude -p+verify)**:Task 3(ops/defaultHandlers/taskDefs)✓
- **步驟級檢查點續跑**:Task 1(checkpoint)+ Task 2(跳過已完成)+ ai_run 產物跳過(Task 3)✓
- **啟動回收 processing/(修舊 bug)**:Task 1(recoverProcessing)+ Task 3 接 worker ✓
- **NDJSON 契約**:Task 2(emit)+ Task 4(parseProgress)✓
- **監控台逐步進度 + needsReview**:Task 4 ✓
- **驗證台動作(開檔/驗收/重跑)**:Task 5 ✓
- **每步可驗證**:各 Task 末有人工驗證步驟 ✓
- **不動 bot_gui / 監聽解密**:全程僅動 element-bot 的 executor/worker/dashboard/config ✓
- 型別一致性:`agentExecutor(task, ctx)`、`make(ops)`、handler `({workDir,task,emit,logger,shared})`、`parseProgress(queueDir,id)→{steps,summary}`、`getTaskDef(name)`、`recoverProcessing(queueDir,logger)` 跨 Task 一致 ✓
