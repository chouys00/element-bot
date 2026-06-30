# 關鍵字觸發 AI Agent 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在現有 element-bot 上加一層觸發管線:監聽到的訊息經「關鍵字粗篩 +(逐規則選配)Claude Haiku 4.5 語意判斷」後,把任務寫進檔案佇列,由獨立 worker 程序執行(v1 為 dry-run)。

**Architecture:** 不改動現有「監聽→解密→寫 JSONL」邏輯。新增模組全為純函式(可單元測試)+ 薄薄的串接層。bot 端負責「判斷是否觸發 → 寫佇列」;另一支 `worker.js` 獨立程序消化佇列、跑 executor。executor 做成可插拔介面,v1 只印出任務(dry-run),日後替換為真正的 agent 呼叫時 bot 與佇列格式皆不動。

**Tech Stack:** Node.js ≥22、CommonJS、`@anthropic-ai/sdk`(LLM 判斷)、純 node `assert` 測試(無框架,沿用既有 `test/*.test.js` 風格)、檔案系統佇列。

**規格來源:** [docs/superpowers/specs/2026-06-25-keyword-trigger-agent-design.md](../specs/2026-06-25-keyword-trigger-agent-design.md)

---

## 重要慣例(請先讀)

- **語言/風格:** 每個 `.js` 檔第一行為 `"use strict";`,用 CommonJS(`require` / `module.exports`),沿用既有 `src/` 風格。
- **測試風格:** 不用任何測試框架。每個測試檔用 `const assert = require("assert");`,用底下這個 `ok(name, cond)` 小工具累加計數,最後 `console.log` 印出通過數。直接用 `node test/<檔名>` 執行;全部 assert 通過則 exit 0。
- **純函式優先:** 所有判斷邏輯放純函式,檔案系統/網路放薄薄的 wrapper。
- **不要自由發揮:** 每一步的程式碼是完整的,照貼即可。不要新增未列出的「錯誤處理」「驗證」「邊界情況」。
- **Windows 環境:** 指令用 Git Bash 語法可執行;路徑用正斜線。

測試檔共用的 `ok` 樣板(下面每個測試檔都會包含這段,照貼):
```js
let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}
```

---

## 檔案結構(本計畫會建立/異動)

| 路徑 | 動作 | 責任 |
|------|------|------|
| `config/rules.json` | 建立 | 規則設定(關鍵字、task、是否用 LLM、intent、extract) |
| `src/rules.js` | 建立 | 載入並驗證規則(純函式) |
| `src/matcher.js` | 建立 | 關鍵字粗篩(純函式) |
| `src/enqueue.js` | 建立 | 把任務寫進 `queue/pending/` |
| `src/judge.js` | 建立 | Claude Haiku 4.5 語意判斷(schema/prompt/parse 為純函式) |
| `src/trigger.js` | 建立 | 觸發管線串接(注入 judge/enqueue,可測試) |
| `src/executors/dryRun.js` | 建立 | v1 executor(印出任務,視為成功) |
| `src/workerCore.js` | 建立 | 佇列處理核心(processOne / pollOnce) |
| `src/worker.js` | 建立 | worker 進入點(獨立程序) |
| `src/config.js` | 異動 | 新增 rulesPath / queueDir / pollIntervalMs / anthropicApiKey |
| `src/index.js` | 異動 | processEvent 寫完 JSONL 後串接觸發管線 |
| `.env.example` / `.env` | 異動 | 新增 ANTHROPIC_API_KEY 等 |
| `.gitignore` | 異動 | 加入 `queue/` |
| `package.json` | 異動 | 新增依賴、worker script、test script |
| `test/rules.test.js` 等 | 建立 | 各純函式單元測試 |

---

## Task 1: 專案骨架(依賴、設定檔、config 欄位、.gitignore)

**Files:**
- Modify: `package.json`(新增依賴 + scripts)
- Create: `config/rules.json`
- Modify: `.env.example`、`.env`
- Modify: `.gitignore`
- Modify: `src/config.js`

- [ ] **Step 1: 安裝 Anthropic SDK**

Run:
```bash
cd "D:/GB/element-bot" && npm install @anthropic-ai/sdk
```
Expected: 成功安裝,`package.json` 的 `dependencies` 多出 `@anthropic-ai/sdk`。

- [ ] **Step 2: 建立範例規則檔 `config/rules.json`**

Create `config/rules.json`:
```json
[
  {
    "name": "deploy",
    "keywords": ["部署", "上線", "deploy"],
    "task": "deploy-skill",
    "use_llm": true,
    "intent": "有人要求部署或詢問上線流程時才觸發;在抱怨或回顧過去的部署、單純閒聊則不要觸發",
    "extract": ["環境", "服務名稱"]
  },
  {
    "name": "report",
    "keywords": ["週報", "report"],
    "task": "report-skill",
    "use_llm": false
  }
]
```

- [ ] **Step 3: 更新 `.gitignore`(加入 queue/)**

把 `.gitignore` 改成(在既有內容尾端加一行 `queue/`):
```
node_modules/
.env
storage/
output/
*.log
.idea/
.claude/
queue/
```

- [ ] **Step 4: 更新 `.env.example`**

在 `.env.example` 檔尾追加:
```
# ↓↓↓ 觸發功能:LLM 語意判斷用(只有 use_llm:true 的規則會用到)
ANTHROPIC_API_KEY=

# 觸發功能可選設定(有預設值,通常不用填)
# RULES_PATH=config/rules.json
# QUEUE_DIR=queue
# POLL_INTERVAL_MS=2000
```

- [ ] **Step 5: 更新 `.env`(填入實際金鑰)**

在 `.env` 檔尾追加一行(實際金鑰請使用者自行填;若暫時沒有,先留空,use_llm 規則會被略過):
```
ANTHROPIC_API_KEY=
```

- [ ] **Step 6: 修改 `src/config.js` 載入新欄位**

`src/config.js` 第 2 行目前是 `require("dotenv").config();`。在它下方新增 `const path = require("path");`。

把現有 `loadConfig` 函式裡、`const roomIds = parseRoomIds(...)` 那一行**下方**插入:
```js
  const rulesPath = path.resolve(__dirname, "..", process.env.RULES_PATH || "config/rules.json");
  const queueDir = path.resolve(__dirname, "..", process.env.QUEUE_DIR || "queue");
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;
```

把 `loadConfig` 的 `return { homeserver, userId, password, recoveryKey, deviceName, roomIds };` 改成:
```js
  return { homeserver, userId, password, recoveryKey, deviceName, roomIds, rulesPath, queueDir, pollIntervalMs, anthropicApiKey };
```
> 注意:這四個欄位**不要**加進 `missing` 必填檢查;它們是選配。

- [ ] **Step 7: 驗證 config 可載入**

Run:
```bash
cd "D:/GB/element-bot" && node -e "const {loadConfig}=require('./src/config'); const c=loadConfig(); console.log('queueDir=',c.queueDir,'pollIntervalMs=',c.pollIntervalMs);"
```
Expected: 印出 `queueDir= ...\element-bot\queue pollIntervalMs= 2000`(不報錯)。
> 若報「缺少必要設定」,代表 `.env` 的 Matrix 既有欄位沒填好,與本計畫無關;確認 `.env` 完整即可。

- [ ] **Step 8: Commit**

```bash
cd "D:/GB/element-bot" && git add package.json package-lock.json config/rules.json .gitignore .env.example src/config.js && git commit -m "feat: 觸發功能骨架(依賴/規則檔/config 欄位)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 規則載入與驗證 `src/rules.js`

**Files:**
- Create: `src/rules.js`
- Test: `test/rules.test.js`

- [ ] **Step 1: 寫失敗測試 `test/rules.test.js`**

Create `test/rules.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadRules, validateRule } = require("../src/rules");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function throws(name, fn) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  ok(name, threw);
}

const good = { name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: false };
ok("合法規則通過驗證", validateRule(good, 0) === true);
ok("use_llm:true 且有 intent 通過", validateRule({ ...good, use_llm: true, intent: "x" }, 0) === true);

throws("name 空字串被拒", () => validateRule({ ...good, name: "" }, 0));
throws("keywords 空陣列被拒", () => validateRule({ ...good, keywords: [] }, 0));
throws("task 缺少被拒", () => validateRule({ name: "a", keywords: ["x"], use_llm: false }, 0));
throws("use_llm 非布林被拒", () => validateRule({ ...good, use_llm: "yes" }, 0));
throws("use_llm:true 但缺 intent 被拒", () => validateRule({ ...good, use_llm: true }, 0));
throws("extract 非字串陣列被拒", () => validateRule({ ...good, extract: [1, 2] }, 0));

// loadRules 從檔案
const tmp = path.join(os.tmpdir(), `rules-test-${Date.now()}.json`);
fs.writeFileSync(tmp, JSON.stringify([good]), "utf8");
const loaded = loadRules(tmp);
ok("loadRules 回傳陣列", Array.isArray(loaded) && loaded.length === 1);
ok("loadRules 內容正確", loaded[0].name === "deploy");
fs.unlinkSync(tmp);

const tmpBad = path.join(os.tmpdir(), `rules-bad-${Date.now()}.json`);
fs.writeFileSync(tmpBad, JSON.stringify({ not: "array" }), "utf8");
throws("loadRules 對非陣列丟錯", () => loadRules(tmpBad));
fs.unlinkSync(tmpBad);

console.log(`rules.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/rules.test.js`
Expected: FAIL — 報錯 `Cannot find module '../src/rules'`。

- [ ] **Step 3: 實作 `src/rules.js`**

Create `src/rules.js`:
```js
"use strict";
const fs = require("fs");

// 驗證單一規則物件;不合法即丟出 Error。合法回傳 true。
function validateRule(rule, index) {
  const where = `rules[${index}]`;
  if (!rule || typeof rule !== "object") throw new Error(`${where} 不是物件`);
  if (typeof rule.name !== "string" || !rule.name) throw new Error(`${where}.name 必須為非空字串`);
  if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) throw new Error(`${where}.keywords 必須為非空陣列`);
  if (!rule.keywords.every((k) => typeof k === "string" && k)) throw new Error(`${where}.keywords 必須都是非空字串`);
  if (typeof rule.task !== "string" || !rule.task) throw new Error(`${where}.task 必須為非空字串`);
  if (typeof rule.use_llm !== "boolean") throw new Error(`${where}.use_llm 必須為布林`);
  if (rule.use_llm && (typeof rule.intent !== "string" || !rule.intent)) throw new Error(`${where}.intent 在 use_llm 時必填`);
  if (rule.extract !== undefined) {
    if (!Array.isArray(rule.extract) || !rule.extract.every((e) => typeof e === "string" && e)) {
      throw new Error(`${where}.extract 必須為非空字串陣列`);
    }
  }
  return true;
}

// 從檔案載入並逐條驗證規則,回傳規則陣列。
function loadRules(rulesPath) {
  const raw = fs.readFileSync(rulesPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("rules.json 最外層必須是陣列");
  parsed.forEach((r, i) => validateRule(r, i));
  return parsed;
}

module.exports = { loadRules, validateRule };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/rules.test.js`
Expected: PASS — 印出 `rules.test.js: 14 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/rules.js test/rules.test.js && git commit -m "feat: 規則載入與驗證 src/rules.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 關鍵字粗篩 `src/matcher.js`

**Files:**
- Create: `src/matcher.js`
- Test: `test/matcher.test.js`

- [ ] **Step 1: 寫失敗測試 `test/matcher.test.js`**

Create `test/matcher.test.js`:
```js
"use strict";
const assert = require("assert");
const { matchRules } = require("../src/matcher");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const rules = [
  { name: "deploy", keywords: ["部署", "deploy"], task: "t1", use_llm: false },
  { name: "report", keywords: ["週報"], task: "t2", use_llm: false },
];

ok("命中中文關鍵字", matchRules("我要部署一下", rules).map((r) => r.name).join() === "deploy");
ok("命中英文關鍵字(大小寫不敏感)", matchRules("please DEPLOY now", rules).map((r) => r.name).join() === "deploy");
ok("未命中回空陣列", matchRules("今天天氣很好", rules).length === 0);
ok("一則可命中多條", matchRules("部署完發週報", rules).length === 2);
ok("body 非字串回空陣列", matchRules(null, rules).length === 0);
ok("rules 非陣列回空陣列", matchRules("部署", null).length === 0);

console.log(`matcher.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/matcher.test.js`
Expected: FAIL — `Cannot find module '../src/matcher'`。

- [ ] **Step 3: 實作 `src/matcher.js`**

Create `src/matcher.js`:
```js
"use strict";
// 純函式:在訊息內文中比對規則關鍵字(大小寫不敏感、子字串比對)。
// 回傳所有命中的規則物件陣列(可能 0~多條)。
function matchRules(body, rules) {
  if (typeof body !== "string" || !Array.isArray(rules)) return [];
  const hay = body.toLowerCase();
  return rules.filter(
    (rule) =>
      Array.isArray(rule.keywords) &&
      rule.keywords.some((kw) => typeof kw === "string" && hay.includes(kw.toLowerCase()))
  );
}

module.exports = { matchRules };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/matcher.test.js`
Expected: PASS — `matcher.test.js: 6 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/matcher.js test/matcher.test.js && git commit -m "feat: 關鍵字粗篩 src/matcher.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 任務入列 `src/enqueue.js`

**Files:**
- Create: `src/enqueue.js`
- Test: `test/enqueue.test.js`

- [ ] **Step 1: 寫失敗測試 `test/enqueue.test.js`**

Create `test/enqueue.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { enqueueTask } = require("../src/enqueue");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const queueDir = path.join(os.tmpdir(), `queue-test-${Date.now()}`);
const task = { rule: "deploy", task: "deploy-skill", params: { 環境: "prod" } };

const file = enqueueTask(queueDir, task);
ok("回傳路徑存在", fs.existsSync(file));
ok("檔案落在 pending 目錄", path.dirname(file) === path.join(queueDir, "pending"));
ok("副檔名為 .json", file.endsWith(".json"));

const readBack = JSON.parse(fs.readFileSync(file, "utf8"));
ok("內容可往返", readBack.rule === "deploy" && readBack.params.環境 === "prod");

// 兩次入列不會撞檔名
const file2 = enqueueTask(queueDir, task);
ok("連續入列產生不同檔名", file !== file2);

fs.rmSync(queueDir, { recursive: true, force: true });
console.log(`enqueue.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/enqueue.test.js`
Expected: FAIL — `Cannot find module '../src/enqueue'`。

- [ ] **Step 3: 實作 `src/enqueue.js`**

Create `src/enqueue.js`:
```js
"use strict";
const fs = require("fs");
const path = require("path");

// 把一筆任務寫進 <queueDir>/pending/ 下的唯一檔名 JSON。回傳寫入的完整路徑。
function enqueueTask(queueDir, task) {
  const pendingDir = path.join(queueDir, "pending");
  fs.mkdirSync(pendingDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const safeRule = String(task.rule || "rule").replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = path.join(pendingDir, `${ts}-${safeRule}-${rand}.json`);
  fs.writeFileSync(file, JSON.stringify(task, null, 2), "utf8");
  return file;
}

module.exports = { enqueueTask };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/enqueue.test.js`
Expected: PASS — `enqueue.test.js: 5 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/enqueue.js test/enqueue.test.js && git commit -m "feat: 任務入列 src/enqueue.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: LLM 語意判斷 `src/judge.js`

> 說明:`judge` 本身會呼叫 Anthropic API,不在單元測試中真打 API。因此把 **schema 組裝 / prompt 組裝 / 回應解析** 拆成純函式並測試;`judge` 只是把它們和 `client.messages.create` 串起來。

**Files:**
- Create: `src/judge.js`
- Test: `test/judge.test.js`

- [ ] **Step 1: 寫失敗測試 `test/judge.test.js`**

Create `test/judge.test.js`:
```js
"use strict";
const assert = require("assert");
const { buildSchema, buildUserText, parseJudgeResponse } = require("../src/judge");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}
function throws(name, fn) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  ok(name, threw);
}

// buildSchema
const schemaWith = buildSchema({ extract: ["環境", "服務名稱"] });
ok("schema 頂層含 trigger 與 params 必填", schemaWith.required.join() === "trigger,params");
ok("schema params 含 extract 欄位", schemaWith.properties.params.properties.環境.type === "string");
ok("schema params required 含全部 extract", schemaWith.properties.params.required.join() === "環境,服務名稱");

const schemaNone = buildSchema({});
ok("無 extract 時 params 無屬性", Object.keys(schemaNone.properties.params.properties).length === 0);

// buildUserText
const text = buildUserText({ intent: "要部署才觸發", extract: ["環境"] }, "我要部署");
ok("prompt 含 intent", text.includes("要部署才觸發"));
ok("prompt 含訊息內容", text.includes("我要部署"));
ok("prompt 含抽欄位指示", text.includes("環境"));

// parseJudgeResponse
const okResp = parseJudgeResponse([{ type: "text", text: '{"trigger":true,"params":{"環境":"prod"}}' }]);
ok("解析 trigger=true", okResp.trigger === true);
ok("解析 params", okResp.params.環境 === "prod");

throws("缺 text block 丟錯", () => parseJudgeResponse([{ type: "image" }]));
throws("trigger 非布林丟錯", () => parseJudgeResponse([{ type: "text", text: '{"params":{}}' }]));

console.log(`judge.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/judge.test.js`
Expected: FAIL — `Cannot find module '../src/judge'`。

- [ ] **Step 3: 實作 `src/judge.js`**

Create `src/judge.js`:
```js
"use strict";
// 用 Claude Haiku 4.5 判斷「命中關鍵字的訊息是否真的該觸發」並抽參數。
// schema / prompt / parse 為純函式以利測試;judge() 串接它們並呼叫 API。

// 依規則的 extract 欄位組出 structured-output 的 JSON schema。
// 注意:structured outputs 要求每個 object 都 additionalProperties:false,且 properties 全列入 required。
function buildSchema(rule) {
  const extract = Array.isArray(rule.extract) ? rule.extract : [];
  const paramProps = {};
  for (const field of extract) paramProps[field] = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      trigger: { type: "boolean" },
      params: {
        type: "object",
        additionalProperties: false,
        properties: paramProps,
        required: extract.slice(),
      },
    },
    required: ["trigger", "params"],
  };
}

// 組出給模型的 user 文字。
function buildUserText(rule, message) {
  const extract = Array.isArray(rule.extract) ? rule.extract : [];
  const extractLine = extract.length
    ? `若 trigger=true,從訊息抽出這些欄位(找不到就填空字串):${extract.join("、")}。`
    : "不需要抽任何欄位,params 回傳空物件 {}。";
  return [
    `觸發條件(intent):${rule.intent}`,
    `訊息內容:「${message}」`,
    "判斷這則訊息是否符合上述觸發條件。符合 trigger=true,否則 trigger=false。",
    extractLine,
  ].join("\n");
}

const SYSTEM =
  "你是訊息觸發判斷器。只依使用者提供的觸發條件,判斷訊息是否該觸發,並依指示抽出參數。只輸出符合 schema 的 JSON,不要多餘文字。";

// 從 API 回傳的 content blocks 取出文字並解析成 {trigger, params}。
function parseJudgeResponse(content) {
  if (!Array.isArray(content)) throw new Error("回應 content 不是陣列");
  const textBlock = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  if (!textBlock) throw new Error("回應缺少 text block");
  const parsed = JSON.parse(textBlock.text);
  if (typeof parsed.trigger !== "boolean") throw new Error("回應缺少布林 trigger");
  return { trigger: parsed.trigger, params: parsed.params || {} };
}

// 實際呼叫 API。client 為 @anthropic-ai/sdk 的 Anthropic 實例。
async function judge(client, rule, message) {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserText(rule, message) }],
    output_config: { format: { type: "json_schema", schema: buildSchema(rule) } },
  });
  return parseJudgeResponse(resp.content);
}

module.exports = { buildSchema, buildUserText, parseJudgeResponse, judge, SYSTEM };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/judge.test.js`
Expected: PASS — `judge.test.js: 11 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/judge.js test/judge.test.js && git commit -m "feat: LLM 語意判斷 src/judge.js（Claude Haiku 4.5）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 觸發管線 `src/trigger.js`

> 說明:`runTriggerPipeline` 注入 `judgeFn` 與 `enqueueFn`,因此可用 stub 測試而不打 API、不寫實體佇列。它的責任:粗篩 → 逐規則決定直接觸發或經 LLM → 觸發則組任務並 enqueue;**單條規則出錯只記 log,不中斷其他規則、不向外丟出**。

**Files:**
- Create: `src/trigger.js`
- Test: `test/trigger.test.js`

- [ ] **Step 1: 寫失敗測試 `test/trigger.test.js`**

Create `test/trigger.test.js`:
```js
"use strict";
const assert = require("assert");
const { runTriggerPipeline } = require("../src/trigger");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const silentLogger = { log() {}, error() {} };

function rec(body) {
  return { room_id: "!r:s", sender: "@a:s", event_id: "$e", content: { body } };
}

(async () => {
  // 1) use_llm:false → 直接 enqueue
  {
    const enqueued = [];
    const rules = [{ name: "report", keywords: ["週報"], task: "report-skill", use_llm: false }];
    await runTriggerPipeline(rec("發週報"), {
      rules,
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f1"; },
      logger: silentLogger,
    });
    ok("use_llm:false 直接觸發並入列", enqueued.length === 1 && enqueued[0].task === "report-skill");
    ok("未命中規則不該被處理", enqueued[0].rule === "report");
  }

  // 2) use_llm:true 且 LLM 說 trigger:true → enqueue,帶 params
  {
    const enqueued = [];
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x", extract: ["環境"] }];
    await runTriggerPipeline(rec("我要部署"), {
      rules,
      judgeFn: async () => ({ trigger: true, params: { 環境: "prod" } }),
      enqueueFn: (t) => { enqueued.push(t); return "f2"; },
      logger: silentLogger,
    });
    ok("LLM 觸發則入列", enqueued.length === 1);
    ok("入列任務帶 LLM 抽出的 params", enqueued[0].params.環境 === "prod");
    ok("任務含 source 訊息資訊", enqueued[0].source.body === "我要部署");
  }

  // 3) use_llm:true 但 LLM 說 trigger:false → 不 enqueue
  {
    const enqueued = [];
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x" }];
    await runTriggerPipeline(rec("昨天那個部署掛了"), {
      rules,
      judgeFn: async () => ({ trigger: false, params: {} }),
      enqueueFn: (t) => { enqueued.push(t); return "f3"; },
      logger: silentLogger,
    });
    ok("LLM 不觸發則不入列", enqueued.length === 0);
  }

  // 4) judgeFn 丟例外 → 不 enqueue、不向外丟出
  {
    const enqueued = [];
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x" }];
    let threwOut = false;
    try {
      await runTriggerPipeline(rec("我要部署"), {
        rules,
        judgeFn: async () => { throw new Error("API 壞了"); },
        enqueueFn: (t) => { enqueued.push(t); return "f4"; },
        logger: silentLogger,
      });
    } catch (_) { threwOut = true; }
    ok("judge 失敗不向外丟出", threwOut === false);
    ok("judge 失敗不入列", enqueued.length === 0);
  }

  console.log(`trigger.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/trigger.test.js`
Expected: FAIL — `Cannot find module '../src/trigger'`。

- [ ] **Step 3: 實作 `src/trigger.js`**

Create `src/trigger.js`:
```js
"use strict";
const { matchRules } = require("./matcher");

// 觸發管線(注入 judgeFn / enqueueFn / logger 以利測試與替換)。
// deps = { rules, judgeFn(rule, body)->{trigger,params}, enqueueFn(task)->filepath, logger }
// 對一則正規化訊息 rec:粗篩 → 逐條命中規則決定直接觸發或經 LLM → 觸發則 enqueue。
// 單條規則的任何錯誤只記 log,不中斷其他規則,也不向外丟出。
async function runTriggerPipeline(rec, deps) {
  const { rules, judgeFn, enqueueFn, logger } = deps;
  const body = rec && rec.content && rec.content.body;
  const matched = matchRules(body, rules);
  for (const rule of matched) {
    try {
      let params = {};
      if (rule.use_llm) {
        const result = await judgeFn(rule, body);
        if (!result || result.trigger !== true) {
          logger.log(`[trigger] 規則 ${rule.name} LLM 判定不觸發`);
          continue;
        }
        params = result.params || {};
      }
      const task = {
        rule: rule.name,
        task: rule.task,
        params,
        source: {
          room_id: rec.room_id,
          sender: rec.sender,
          event_id: rec.event_id,
          body,
        },
        enqueued_at: new Date().toISOString(),
      };
      const file = enqueueFn(task);
      logger.log(`[trigger] 規則 ${rule.name} 觸發 → ${file}`);
    } catch (err) {
      logger.error(`[trigger] 規則 ${rule.name} 處理失敗(略過):`, err.message);
    }
  }
}

module.exports = { runTriggerPipeline };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/trigger.test.js`
Expected: PASS — `trigger.test.js: 9 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/trigger.js test/trigger.test.js && git commit -m "feat: 觸發管線 src/trigger.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: dry-run executor `src/executors/dryRun.js`

**Files:**
- Create: `src/executors/dryRun.js`
- Test: `test/dryRun.test.js`

- [ ] **Step 1: 寫失敗測試 `test/dryRun.test.js`**

Create `test/dryRun.test.js`:
```js
"use strict";
const assert = require("assert");
const { dryRunExecutor } = require("../src/executors/dryRun");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

(async () => {
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(" ")), error: () => {} };
  const task = { rule: "deploy", task: "deploy-skill", params: { 環境: "prod" } };

  await dryRunExecutor(task, { logger });
  ok("dry-run 有印出一行", lines.length === 1);
  ok("印出內容含 task 名", lines[0].includes("deploy-skill"));
  ok("印出內容含 params", lines[0].includes("prod"));

  console.log(`dryRun.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/dryRun.test.js`
Expected: FAIL — `Cannot find module '../src/executors/dryRun'`。

- [ ] **Step 3: 實作 `src/executors/dryRun.js`**

Create `src/executors/dryRun.js`:
```js
"use strict";
// v1 executor:不實際跑 agent,只把任務印出來,直接視為成功。
// 介面:async (task, { logger }) => void;丟出例外代表「失敗」(會被 worker 移到 failed/)。
// 日後替換為真正呼叫 agent 的 executor 時,維持同樣介面即可,bot 與佇列格式皆不動。
async function dryRunExecutor(task, { logger }) {
  logger.log(`[executor:dry-run] 任務 ${task.rule} → ${task.task} params=${JSON.stringify(task.params)}`);
}

module.exports = { dryRunExecutor };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/dryRun.test.js`
Expected: PASS — `dryRun.test.js: 3 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/executors/dryRun.js test/dryRun.test.js && git commit -m "feat: dry-run executor src/executors/dryRun.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 佇列處理核心 `src/workerCore.js`

> 說明:`processOne(filePath, deps)` 讀一個 pending 任務檔 → 跑 executor → 成功移 `done/`、失敗移 `failed/`(並寫一個 `.error.txt`)。`pollOnce(deps)` 掃 `pending/` 一輪逐筆處理。executor 注入,可用 stub 測試。

**Files:**
- Create: `src/workerCore.js`
- Test: `test/workerCore.test.js`

- [ ] **Step 1: 寫失敗測試 `test/workerCore.test.js`**

Create `test/workerCore.test.js`:
```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { processOne, pollOnce } = require("../src/workerCore");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const dir = path.join(os.tmpdir(), `wq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(dir, "pending"), { recursive: true });
  return dir;
}

function writePending(queueDir, name, obj) {
  const p = path.join(queueDir, "pending", name);
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

(async () => {
  // 成功 → done/
  {
    const q = freshQueue();
    const f = writePending(q, "a.json", { rule: "r", task: "t", params: {} });
    const ran = [];
    const res = await processOne(f, { queueDir: q, executor: async (t) => ran.push(t), logger: silentLogger });
    ok("成功回傳 done", res === "done");
    ok("executor 有被呼叫", ran.length === 1);
    ok("原檔已移走", !fs.existsSync(f));
    ok("檔案在 done/", fs.existsSync(path.join(q, "done", "a.json")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // executor 丟錯 → failed/ + .error.txt
  {
    const q = freshQueue();
    const f = writePending(q, "b.json", { rule: "r", task: "t", params: {} });
    const res = await processOne(f, { queueDir: q, executor: async () => { throw new Error("boom"); }, logger: silentLogger });
    ok("失敗回傳 failed", res === "failed");
    ok("檔案在 failed/", fs.existsSync(path.join(q, "failed", "b.json")));
    ok("有寫 .error.txt", fs.existsSync(path.join(q, "failed", "b.json.error.txt")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // 壞 JSON → failed/
  {
    const q = freshQueue();
    const p = path.join(q, "pending", "c.json");
    fs.writeFileSync(p, "{ not json", "utf8");
    const res = await processOne(p, { queueDir: q, executor: async () => {}, logger: silentLogger });
    ok("壞 JSON 回傳 failed", res === "failed");
    ok("壞 JSON 移到 failed/", fs.existsSync(path.join(q, "failed", "c.json")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // pollOnce 處理多筆
  {
    const q = freshQueue();
    writePending(q, "1.json", { rule: "r", task: "t", params: {} });
    writePending(q, "2.json", { rule: "r", task: "t", params: {} });
    const n = await pollOnce({ queueDir: q, executor: async () => {}, logger: silentLogger });
    ok("pollOnce 回傳處理筆數", n === 2);
    ok("pending 已清空", fs.readdirSync(path.join(q, "pending")).filter((f) => f.endsWith(".json")).length === 0);
    fs.rmSync(q, { recursive: true, force: true });
  }

  console.log(`workerCore.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 執行測試,確認失敗**

Run: `cd "D:/GB/element-bot" && node test/workerCore.test.js`
Expected: FAIL — `Cannot find module '../src/workerCore'`。

- [ ] **Step 3: 實作 `src/workerCore.js`**

Create `src/workerCore.js`:
```js
"use strict";
const fs = require("fs");
const path = require("path");

// 處理單一 pending 任務檔:讀取 → 執行 executor → 成功移 done/、失敗移 failed/。
// deps = { queueDir, executor(task, { logger })->Promise, logger }
// 回傳 "done" | "failed"。
async function processOne(filePath, deps) {
  const { queueDir, executor, logger } = deps;
  const doneDir = path.join(queueDir, "done");
  const failedDir = path.join(queueDir, "failed");
  const base = path.basename(filePath);

  let task;
  try {
    task = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fs.mkdirSync(failedDir, { recursive: true });
    fs.renameSync(filePath, path.join(failedDir, base));
    logger.error(`[worker] ${base} 解析失敗 → failed/:`, err.message);
    return "failed";
  }

  try {
    await executor(task, { logger });
    fs.mkdirSync(doneDir, { recursive: true });
    fs.renameSync(filePath, path.join(doneDir, base));
    logger.log(`[worker] ${base} 完成 → done/`);
    return "done";
  } catch (err) {
    fs.mkdirSync(failedDir, { recursive: true });
    const dest = path.join(failedDir, base);
    fs.renameSync(filePath, dest);
    fs.writeFileSync(dest + ".error.txt", String((err && err.stack) || err), "utf8");
    logger.error(`[worker] ${base} 執行失敗 → failed/:`, err.message);
    return "failed";
  }
}

// 掃描 pending/ 一輪,逐筆 processOne。回傳處理筆數。
async function pollOnce(deps) {
  const { queueDir } = deps;
  const pendingDir = path.join(queueDir, "pending");
  if (!fs.existsSync(pendingDir)) return 0;
  const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")).sort();
  let n = 0;
  for (const f of files) {
    await processOne(path.join(pendingDir, f), deps);
    n++;
  }
  return n;
}

module.exports = { processOne, pollOnce };
```

- [ ] **Step 4: 執行測試,確認通過**

Run: `cd "D:/GB/element-bot" && node test/workerCore.test.js`
Expected: PASS — `workerCore.test.js: 11 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/workerCore.js test/workerCore.test.js && git commit -m "feat: 佇列處理核心 src/workerCore.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: worker 進入點 `src/worker.js` 與 package.json scripts

**Files:**
- Create: `src/worker.js`
- Modify: `package.json`(新增 `worker` script、更新 `test` script)

- [ ] **Step 1: 實作 `src/worker.js`**

Create `src/worker.js`:
```js
"use strict";
const { loadConfig } = require("./config");
const { pollOnce } = require("./workerCore");
const { dryRunExecutor } = require("./executors/dryRun");

async function main() {
  const config = loadConfig();
  const logger = console;
  const deps = { queueDir: config.queueDir, executor: dryRunExecutor, logger };

  logger.log(`[worker] 啟動,監看 ${config.queueDir}/pending,每 ${config.pollIntervalMs}ms 掃描一次`);

  const tick = async () => {
    try {
      await pollOnce(deps);
    } catch (err) {
      logger.error("[worker] 掃描錯誤:", err.message);
    }
  };

  await tick();
  setInterval(tick, config.pollIntervalMs);
}

main().catch((err) => {
  console.error("[worker] 啟動失敗:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 更新 `package.json` 的 scripts**

把 `package.json` 的 `"scripts"` 區塊改成:
```json
  "scripts": {
    "start": "node src/index.js",
    "worker": "node src/worker.js",
    "test": "node test/handler.test.js && node test/normalize.test.js && node test/rules.test.js && node test/matcher.test.js && node test/enqueue.test.js && node test/judge.test.js && node test/trigger.test.js && node test/dryRun.test.js && node test/workerCore.test.js"
  },
```

- [ ] **Step 3: 跑全部測試,確認都綠**

Run: `cd "D:/GB/element-bot" && npm test`
Expected: 依序印出 9 個測試檔的「N 項通過 ✅」,exit 0。

- [ ] **Step 4: 手動驗證 worker 能消化佇列(dry-run)**

先手動丟一筆假任務,再開 worker 看它被處理。
Run(寫入一筆假 pending 任務):
```bash
cd "D:/GB/element-bot" && node -e "const {enqueueTask}=require('./src/enqueue'); const {loadConfig}=require('./src/config'); const c=loadConfig(); console.log(enqueueTask(c.queueDir,{rule:'report',task:'report-skill',params:{}}));"
```
Expected: 印出 `queue/pending/...json` 路徑。

Run(啟動 worker 約幾秒後 Ctrl+C):
```bash
cd "D:/GB/element-bot" && timeout 5 npm run worker; echo "---"; ls queue/done/ 2>/dev/null
```
Expected: worker 印出 `[executor:dry-run] 任務 report → report-skill ...` 與 `... 完成 → done/`;`queue/done/` 出現該檔。
> 註:`timeout` 在 Git Bash 可用;若不可用,改為手動 `npm run worker` 觀察後按 Ctrl+C,再 `ls queue/done/`。

- [ ] **Step 5: Commit**

```bash
cd "D:/GB/element-bot" && git add src/worker.js package.json && git commit -m "feat: worker 進入點與 npm scripts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: 串接進 bot `src/index.js`

> 說明:在 `processEvent` 寫完 JSONL 之後呼叫觸發管線。用 try/catch 包住,**任何錯誤只記 log,絕不影響訊息擷取**。規則在啟動時載入一次;Anthropic client 延遲建立(沒填 API key 時,use_llm 規則會在 judge 內丟錯 → 被 trigger 的 try/catch 接住 → 該則不觸發但 bot 照常)。

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: 在 `src/index.js` 頂部新增 require**

`src/index.js` 目前第 10 行是 `const { writeEvent, OUTPUT_FILE } = require("./writer");`。在它**下方**新增:
```js
const { loadRules } = require("./rules");
const { runTriggerPipeline } = require("./trigger");
const { judge } = require("./judge");
const { enqueueTask } = require("./enqueue");
```

- [ ] **Step 2: 在 `main()` 載入規則並備妥 judgeFn**

在 `main()` 內、`const client = await buildCryptoClient({...});` 那段**之後**、`const seen = new Set();` 那行**之前**,插入:
```js
  let rules = [];
  try {
    rules = loadRules(config.rulesPath);
    console.log(`[element-bot] 載入 ${rules.length} 條觸發規則`);
  } catch (e) {
    console.warn("[element-bot] 規則載入失敗,觸發功能停用:", e.message);
  }

  let anthropic = null;
  const judgeFn = async (rule, message) => {
    if (!anthropic) {
      if (!config.anthropicApiKey) throw new Error("缺少 ANTHROPIC_API_KEY,無法做 LLM 判斷");
      const Anthropic = require("@anthropic-ai/sdk");
      anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    }
    return judge(anthropic, rule, message);
  };
```

- [ ] **Step 3: 在 `processEvent` 寫完 JSONL 後呼叫觸發管線**

`processEvent` 內目前有這兩行(寫檔 + log):
```js
      writeEvent(toRecord(rec.room_id, rec));
      console.log(`[element-bot] 已擷取 ${rec.room_id} <- ${rec.sender}: ${String(rec.content.body).slice(0, 80)}`);
```
在這兩行**之後、`}` 結束 try 之前**,插入:
```js
      try {
        await runTriggerPipeline(rec, {
          rules,
          judgeFn,
          enqueueFn: (task) => enqueueTask(config.queueDir, task),
          logger: console,
        });
      } catch (err) {
        console.error("[element-bot] 觸發管線錯誤(不影響擷取):", err.message);
      }
```
> 注意:`processEvent` 已是 `async function`,可直接 `await`。`rec` 是 `normalize(event)` 的正規化物件,`rec.content.body` 即訊息明文。

- [ ] **Step 4: 語法檢查(不需登入即可驗證沒打錯字)**

Run: `cd "D:/GB/element-bot" && node --check src/index.js && echo "語法 OK"`
Expected: 印出 `語法 OK`(無語法錯誤)。

- [ ] **Step 5: 全測試回歸**

Run: `cd "D:/GB/element-bot" && npm test`
Expected: 全部測試檔通過,exit 0。

- [ ] **Step 6: Commit**

```bash
cd "D:/GB/element-bot" && git add src/index.js && git commit -m "feat: 將觸發管線串接進 bot（processEvent 後,隔離不影響擷取）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: 端到端手動驗證(對應 spec 驗收標準)

> 說明:此 Task 不寫程式,只驗證整條鏈路。需要 `.env` 已填好 Matrix 帳密+recovery key(現有)與 `ANTHROPIC_API_KEY`(若要驗 use_llm)。**同時只能跑一個 bot 實例**(單實例鎖)。

**Files:** 無(操作驗證)

- [ ] **Step 1: 驗證 use_llm:false 規則(report)**

開兩個終端:
1. 終端 A:`cd "D:/GB/element-bot" && npm start`(等到印出「已開始監聽」)。
2. 到目標房間發一則含「週報」的訊息(例如「我來發週報」)。
3. 觀察終端 A 應印出 `[trigger] 規則 report 觸發 → ...queue/pending/...`。

Run(終端 B 檢查):`cd "D:/GB/element-bot" && ls queue/pending/`
Expected: 出現一個 `*-report-*.json`。

- [ ] **Step 2: 驗證 worker 消化(dry-run)**

Run(終端 B):`cd "D:/GB/element-bot" && npm run worker`
Expected: 印出 `[executor:dry-run] 任務 report → report-skill ...` 與 `... 完成 → done/`;`queue/done/` 出現該檔。按 Ctrl+C 結束 worker。

- [ ] **Step 3: 驗證 use_llm:true 規則(deploy)的語意判斷**

(終端 A 的 bot 持續開著、`.env` 已填 `ANTHROPIC_API_KEY`)
1. 發一則「正面」訊息:「幫我把 api 服務部署到 production」。
   → 終端 A 應印 `規則 deploy 觸發`;`queue/pending/` 出現 `*-deploy-*.json`,且內容 `params` 含環境/服務名稱。
2. 發一則「回顧過去」訊息:「昨天那次部署整個掛掉超慘」。
   → 終端 A 應印 `規則 deploy LLM 判定不觸發`;**不**產生新任務檔。

Run(終端 B 檢查 deploy 任務內容):`cd "D:/GB/element-bot" && cat queue/pending/*deploy*.json 2>/dev/null || echo "(已被 worker 消化或尚無)"`
Expected: 若存在,JSON 內含 `"rule": "deploy"` 與 `params`。

- [ ] **Step 4: 驗證隔離性(LLM 故障不影響擷取)**

1. 暫時把 `.env` 的 `ANTHROPIC_API_KEY` 改成一個錯的值(例如 `sk-bad`),重啟 bot(`npm start`)。
2. 發一則含「部署」的訊息。
3. 觀察:終端 A 應印 `[trigger] 規則 deploy 處理失敗(略過): ...`,但**同一則訊息仍被擷取**(`output/messages.jsonl` 有新增一行,且印出 `已擷取 ...`)。

Run(終端 B 確認擷取仍正常):`cd "D:/GB/element-bot" && tail -1 output/messages.jsonl`
Expected: 最後一行為剛剛那則訊息的 JSON(證明 LLM 故障沒有打斷擷取)。
> 驗證後把 `.env` 的 `ANTHROPIC_API_KEY` 改回正確值。

- [ ] **Step 5: 最終回歸 + 收尾**

Run: `cd "D:/GB/element-bot" && npm test`
Expected: 全部測試通過。

整理 done/failed(可選):`cd "D:/GB/element-bot" && ls queue/done queue/failed 2>/dev/null`
> `queue/` 已在 `.gitignore`,不會被提交。本 Task 無程式碼變更,無需 commit。

---

## 自我檢查(計畫對照 spec)

- ✅ 持續監聽:沿用現有架構(spec「監聽持續性」)— Task 10 串接在現有迴圈,未改動監聽。
- ✅ 關鍵字粗篩(程式、確定性):Task 3 `matcher.js`。
- ✅ 逐規則選配 LLM:Task 5 `judge.js` + Task 6 `trigger.js`(`use_llm` 分支)。
- ✅ JSON 規則檔:Task 1 `config/rules.json` + Task 2 `rules.js` 驗證。
- ✅ Claude Haiku 4.5:Task 5 model 字串 `claude-haiku-4-5`。
- ✅ 檔案佇列 pending/done/failed:Task 4 enqueue、Task 8 workerCore。
- ✅ 獨立 worker:Task 9 `worker.js` + `npm run worker`。
- ✅ 可插拔 executor、v1 dry-run:Task 7 `dryRun.js`(介面 `async (task,{logger})`)。
- ✅ 隔離性(觸發失敗不影響擷取):Task 10 try/catch + Task 11 Step 4 驗證。
- ✅ 設定/金鑰:Task 1 config 欄位 + `.env`。
- ✅ 驗收標準 1–5:對應 Task 11 Step 1–5 與 `npm test`。

型別/命名一致性檢查:`matchRules`、`loadRules`/`validateRule`、`enqueueTask`、`buildSchema`/`buildUserText`/`parseJudgeResponse`/`judge`、`runTriggerPipeline`、`dryRunExecutor`、`processOne`/`pollOnce` 在定義與被引用處名稱一致;executor 介面 `async (task, { logger })` 在 dryRun 與 workerCore 測試一致;task 物件結構(`rule`/`task`/`params`/`source`/`enqueued_at`)在 trigger 產生處與 worker 消化處一致。
```
