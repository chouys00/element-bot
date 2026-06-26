# 監控儀表板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為 element-bot 加上本地網頁監控台,顯示訊息觸發的任務、即時狀態(待處理/進行中/完成/失敗)與可點擊的日誌占位,並做連帶的佇列升級。

**Architecture:** 第三個獨立程序(只讀檔)提供 HTTP API + vanilla JS 前端,每 1–2s 輪詢。worker 新增 `processing/` 狀態;bot 寫 `storage/rooms.json`(房間名稱)與 `storage/bot-heartbeat`(存活)兩個 sidecar。

**Tech Stack:** Node 內建 `http`(無框架)、vanilla JS、CommonJS;測試沿用 `node + assert + ok()` 風格。

對應 spec:[docs/superpowers/specs/2026-06-26-ui-dashboard-design.md](../specs/2026-06-26-ui-dashboard-design.md)

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|------|------|------|
| `src/workerCore.js` | 改 | `processOne` 加 `pending → processing → done/failed` 流轉 |
| `src/heartbeat.js` | 新 | 寫/讀心跳檔、判斷新鮮度 |
| `src/roomsSidecar.js` | 新 | 寫/讀 rooms.json、room_id 翻譯、從 client 建映射 |
| `src/dashboard/aggregate.js` | 新 | 彙整四目錄任務、狀態統計、訊息尾段、日誌解析(純 I/O 函式) |
| `src/dashboard/server.js` | 新 | Node `http` 伺服器,路由 + 靜態檔,綁 127.0.0.1 |
| `src/dashboard/index.js` | 新 | 儀表板進入點(讀設定 → 起 server) |
| `src/dashboard/public/index.html` | 新 | 前端單頁(HTML+JS+CSS) |
| `src/config.js` | 改 | 加 `loadDashboardConfig()`(不需 matrix 憑證) |
| `src/index.js` | 改 | 串接 heartbeat + rooms sidecar |
| `package.json` | 改 | 加 `dashboard` script、擴充 `test` |
| `.env.example` | 改 | 加 `DASHBOARD_PORT` |
| `test/workerCore.test.js` | 改 | 加 processing/ 流轉測試 |
| `test/heartbeat.test.js` | 新 | 心跳測試 |
| `test/roomsSidecar.test.js` | 新 | sidecar 測試 |
| `test/aggregate.test.js` | 新 | 彙整函式測試 |
| `test/dashboardServer.test.js` | 新 | server 端對端測試 |

---

## Task 1: worker 加入 processing/ 流轉

**Files:**
- Modify: `src/workerCore.js`
- Test: `test/workerCore.test.js`

- [ ] **Step 1: 在 `test/workerCore.test.js` 既有 IIFE 內、`console.log(...)` 之前,加入兩個新測試區塊**

```js
  {
    const q = freshQueue();
    const f = writePending(q, "p.json", { rule: "r", task: "t", params: {} });
    let sawProcessing = false;
    await processOne(f, {
      queueDir: q,
      executor: async () => { sawProcessing = fs.existsSync(path.join(q, "processing", "p.json")); },
      logger: silentLogger,
    });
    ok("執行期間檔案在 processing/", sawProcessing);
    ok("完成後移到 done/", fs.existsSync(path.join(q, "done", "p.json")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  {
    const q = freshQueue();
    fs.mkdirSync(path.join(q, "processing"), { recursive: true });
    fs.writeFileSync(path.join(q, "processing", "x.json"), JSON.stringify({ rule: "r", task: "t", params: {} }), "utf8");
    let ran = 0;
    const n = await pollOnce({ queueDir: q, executor: async () => { ran++; }, logger: silentLogger });
    ok("pollOnce 不處理 processing/", ran === 0 && n === 0);
    fs.rmSync(q, { recursive: true, force: true });
  }
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/workerCore.test.js`
Expected: FAIL — `執行期間檔案在 processing/` 斷言失敗(目前直接 pending→done,沒有 processing/)。

- [ ] **Step 3: 改寫 `src/workerCore.js` 的 `processOne`**(整個函式替換成下列)

```js
async function processOne(filePath, deps) {
  const { queueDir, executor, logger } = deps;
  const processingDir = path.join(queueDir, "processing");
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

  // 開始執行前先移到 processing/:儀表板可顯示「進行中」,且 pollOnce 只掃 pending/ 故不會重入。
  fs.mkdirSync(processingDir, { recursive: true });
  const processingPath = path.join(processingDir, base);
  fs.renameSync(filePath, processingPath);

  try {
    await executor(task, { logger });
    fs.mkdirSync(doneDir, { recursive: true });
    fs.renameSync(processingPath, path.join(doneDir, base));
    logger.log(`[worker] ${base} 完成 → done/`);
    return "done";
  } catch (err) {
    fs.mkdirSync(failedDir, { recursive: true });
    const dest = path.join(failedDir, base);
    fs.renameSync(processingPath, dest);
    fs.writeFileSync(dest + ".error.txt", String((err && err.stack) || err), "utf8");
    logger.error(`[worker] ${base} 執行失敗 → failed/:`, err.message);
    return "failed";
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node test/workerCore.test.js`
Expected: PASS — `workerCore.test.js: N 項通過 ✅`(N 含新增 3 項)。

- [ ] **Step 5: Commit**

```bash
git add src/workerCore.js test/workerCore.test.js
git commit -m "feat: worker 加入 processing/ 流轉(進行中狀態)"
```

---

## Task 2: heartbeat 模組

**Files:**
- Create: `src/heartbeat.js`
- Test: `test/heartbeat.test.js`

- [ ] **Step 1: 建立 `test/heartbeat.test.js`**

```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isFresh, readHeartbeat, writeHeartbeat } = require("../src/heartbeat");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

ok("新鮮(剛寫)", isFresh(1000, 1500, 1000) === true);
ok("過期(超過 maxAge)", isFresh(1000, 3000, 1000) === false);
ok("非數字視為不新鮮", isFresh(null, 3000, 1000) === false);

const dir = path.join(os.tmpdir(), `hb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
writeHeartbeat(dir);
const ts = readHeartbeat(dir);
ok("寫入後讀回為數字", typeof ts === "number" && ts > 0);
ok("讀回值接近現在", Math.abs(Date.now() - ts) < 5000);
ok("缺檔回 null", readHeartbeat(path.join(dir, "nope")) === null);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`heartbeat.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/heartbeat.test.js`
Expected: FAIL — `Cannot find module '../src/heartbeat'`。

- [ ] **Step 3: 建立 `src/heartbeat.js`**

```js
"use strict";
const fs = require("fs");
const path = require("path");

// 時間戳是否在 maxAgeMs 內(用來判斷 bot 是否存活)。
function isFresh(ts, now, maxAgeMs) {
  return typeof ts === "number" && ts > 0 && now - ts <= maxAgeMs;
}

// 讀心跳檔,回傳毫秒時間戳;檔案不存在/壞掉回 null。
function readHeartbeat(storageDir) {
  try {
    return parseInt(fs.readFileSync(path.join(storageDir, "bot-heartbeat"), "utf8").trim(), 10);
  } catch (_) {
    return null;
  }
}

// 把當下時間戳寫進心跳檔。
function writeHeartbeat(storageDir) {
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), String(Date.now()), "utf8");
}

// 立即寫一次,之後每 intervalMs 寫一次。回傳停止函式。timer.unref 避免擋住程序退出。
function startHeartbeat(storageDir, intervalMs) {
  writeHeartbeat(storageDir);
  const timer = setInterval(() => writeHeartbeat(storageDir), intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { isFresh, readHeartbeat, writeHeartbeat, startHeartbeat };
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node test/heartbeat.test.js`
Expected: PASS — `heartbeat.test.js: 6 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat.js test/heartbeat.test.js
git commit -m "feat: heartbeat 模組(bot 存活心跳)"
```

---

## Task 3: rooms sidecar 模組

**Files:**
- Create: `src/roomsSidecar.js`
- Test: `test/roomsSidecar.test.js`

- [ ] **Step 1: 建立 `test/roomsSidecar.test.js`**

```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeRoomsSidecar, readRoomsMap, translateRoom, buildRoomEntries } = require("../src/roomsSidecar");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

const dir = path.join(os.tmpdir(), `rs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
writeRoomsSidecar(dir, { "!a:s": "產品群", "!b:s": "維運告警" });
const map = readRoomsMap(dir);
ok("寫入後讀回正確", map["!a:s"] === "產品群" && map["!b:s"] === "維運告警");
ok("缺檔回空物件", Object.keys(readRoomsMap(path.join(dir, "nope"))).length === 0);

ok("有名稱用名稱", translateRoom("!a:s", map) === "產品群");
ok("無名稱回退 room_id", translateRoom("!zzz:s", map) === "!zzz:s");
ok("空 map 回退 room_id", translateRoom("!a:s", {}) === "!a:s");

const fakeClient = { getRoom: (id) => (id === "!a:s" ? { name: "產品群" } : null) };
const entries = buildRoomEntries(fakeClient, ["!a:s", "!b:s"]);
ok("client 有名稱用名稱", entries["!a:s"] === "產品群");
ok("client 無名稱回退 id", entries["!b:s"] === "!b:s");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`roomsSidecar.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/roomsSidecar.test.js`
Expected: FAIL — `Cannot find module '../src/roomsSidecar'`。

- [ ] **Step 3: 建立 `src/roomsSidecar.js`**

```js
"use strict";
const fs = require("fs");
const path = require("path");

// 把 room_id → 名稱 映射寫入 storage/rooms.json。
function writeRoomsSidecar(storageDir, entries) {
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "rooms.json"), JSON.stringify(entries, null, 2), "utf8");
}

// 讀 rooms.json;不存在/壞掉回空物件。
function readRoomsMap(storageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(storageDir, "rooms.json"), "utf8"));
  } catch (_) {
    return {};
  }
}

// 用映射翻譯 room_id;查不到回退顯示原 id。
function translateRoom(roomId, roomsMap) {
  if (roomsMap && roomId && roomsMap[roomId]) return roomsMap[roomId];
  return roomId;
}

// 從 matrix client 與受監聽房間列表建出 id→name 映射(查不到名稱用 id 占位)。
function buildRoomEntries(client, roomIds) {
  const entries = {};
  for (const id of roomIds) {
    const room = client && client.getRoom ? client.getRoom(id) : null;
    entries[id] = (room && room.name) || id;
  }
  return entries;
}

module.exports = { writeRoomsSidecar, readRoomsMap, translateRoom, buildRoomEntries };
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node test/roomsSidecar.test.js`
Expected: PASS — `roomsSidecar.test.js: 8 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
git add src/roomsSidecar.js test/roomsSidecar.test.js
git commit -m "feat: rooms sidecar 模組(房間名稱對照)"
```

---

## Task 4: dashboard 彙整函式

**Files:**
- Create: `src/dashboard/aggregate.js`
- Test: `test/aggregate.test.js`

- [ ] **Step 1: 建立 `test/aggregate.test.js`**

```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { collectTasks, statusCounts, readMessagesTail, resolveTaskLog } = require("../src/dashboard/aggregate");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshRoot() {
  const d = path.join(os.tmpdir(), `agg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  for (const s of ["pending", "processing", "done", "failed", "logs"]) fs.mkdirSync(path.join(d, "queue", s), { recursive: true });
  fs.mkdirSync(path.join(d, "output"), { recursive: true });
  return d;
}
function writeTask(queueDir, status, name, obj) {
  fs.writeFileSync(path.join(queueDir, status, name), JSON.stringify(obj), "utf8");
}

const root = freshRoot();
const queueDir = path.join(root, "queue");
const rooms = { "!r:s": "產品群" };

writeTask(queueDir, "done", "t1.json", { rule: "會議", task: "cal", enqueued_at: "2026-06-26T01:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "hi", event_id: "$1" } });
writeTask(queueDir, "pending", "t2.json", { rule: "退款", task: "ticket", enqueued_at: "2026-06-26T02:00:00.000Z", source: { room_id: "!x:s", sender: "@b", body: "refund", event_id: "$2" } });
fs.writeFileSync(path.join(queueDir, "failed", "bad.json"), "{ not json", "utf8");

const tasks = collectTasks(queueDir, rooms, 100);
ok("收齊三筆(含壞檔)", tasks.length === 3);
ok("依 enqueued_at 新到舊", tasks[0].id === "t2" && tasks[1].id === "t1");
ok("done 任務翻出房間名稱", tasks[1].room_name === "產品群");
ok("無名稱回退 id", tasks[0].room_name === "!x:s");
ok("壞檔標記 parseError", tasks.some((t) => t.parseError === true));
ok("limit 生效", collectTasks(queueDir, rooms, 1).length === 1);

const counts = statusCounts(queueDir);
ok("狀態統計正確", counts.done === 1 && counts.pending === 1 && counts.failed === 1 && counts.processing === 0);

// 日誌:logs 優先 > failed error.txt > 占位
ok("無日誌回占位", resolveTaskLog(queueDir, "t1").source === "none");
fs.writeFileSync(path.join(queueDir, "failed", "bad.json.error.txt"), "boom", "utf8");
ok("有 error.txt 用之", resolveTaskLog(queueDir, "bad").source === "error" && resolveTaskLog(queueDir, "bad").text === "boom");
fs.writeFileSync(path.join(queueDir, "logs", "t1.log"), "ran ok", "utf8");
ok("有 log 優先", resolveTaskLog(queueDir, "t1").source === "log" && resolveTaskLog(queueDir, "t1").text === "ran ok");

const out = path.join(root, "output", "messages.jsonl");
fs.appendFileSync(out, JSON.stringify({ body: "m1" }) + "\n" + JSON.stringify({ body: "m2" }) + "\n", "utf8");
const msgs = readMessagesTail(out, 50);
ok("訊息尾段新到舊", msgs.length === 2 && msgs[0].body === "m2");
ok("缺檔回空陣列", readMessagesTail(path.join(root, "nope.jsonl"), 50).length === 0);

fs.rmSync(root, { recursive: true, force: true });
console.log(`aggregate.test.js: ${passed} 項通過 ✅`);
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/aggregate.test.js`
Expected: FAIL — `Cannot find module '../src/dashboard/aggregate'`。

- [ ] **Step 3: 建立 `src/dashboard/aggregate.js`**

```js
"use strict";
const fs = require("fs");
const path = require("path");
const { translateRoom } = require("../roomsSidecar");

const STATUS_DIRS = ["pending", "processing", "done", "failed"];

// 合併四個狀態目錄的任務檔,翻譯房間名稱,依 enqueued_at 新到舊排序,取前 limit 筆。
// 壞掉的 JSON 不讓整批失敗,標記 parseError 後保留。
function collectTasks(queueDir, roomsMap, limit) {
  const out = [];
  for (const status of STATUS_DIRS) {
    let files;
    try {
      files = fs.readdirSync(path.join(queueDir, status));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      let task;
      try {
        task = JSON.parse(fs.readFileSync(path.join(queueDir, status, f), "utf8"));
      } catch (_) {
        out.push({ id, status, parseError: true });
        continue;
      }
      const src = task.source || {};
      out.push({
        id,
        status,
        rule: task.rule,
        task: task.task,
        room_id: src.room_id,
        room_name: translateRoom(src.room_id, roomsMap),
        sender: src.sender,
        body: src.body,
        event_id: src.event_id,
        enqueued_at: task.enqueued_at,
      });
    }
  }
  out.sort((a, b) => String(b.enqueued_at || "").localeCompare(String(a.enqueued_at || "")));
  return typeof limit === "number" ? out.slice(0, limit) : out;
}

// 各狀態目錄的 .json 數量。
function statusCounts(queueDir) {
  const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const status of STATUS_DIRS) {
    try {
      counts[status] = fs.readdirSync(path.join(queueDir, status)).filter((f) => f.endsWith(".json")).length;
    } catch (_) {}
  }
  return counts;
}

// 解析任務日誌:logs/<id>.log 優先,其次 failed/<id>.json.error.txt,都沒有則占位。
function resolveTaskLog(queueDir, taskId) {
  try {
    return { source: "log", text: fs.readFileSync(path.join(queueDir, "logs", taskId + ".log"), "utf8") };
  } catch (_) {}
  try {
    return { source: "error", text: fs.readFileSync(path.join(queueDir, "failed", taskId + ".json.error.txt"), "utf8") };
  } catch (_) {}
  return { source: "none", text: "executor 尚未寫入日誌" };
}

// messages.jsonl 尾段 n 筆,逐行 parse,新到舊。
function readMessagesTail(outputFile, n) {
  let raw;
  try {
    raw = fs.readFileSync(outputFile, "utf8");
  } catch (_) {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean).slice(-n);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {}
  }
  return out.reverse();
}

module.exports = { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, STATUS_DIRS };
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node test/aggregate.test.js`
Expected: PASS — `aggregate.test.js: 13 項通過 ✅`。

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/aggregate.js test/aggregate.test.js
git commit -m "feat: dashboard 彙整函式(任務/狀態/日誌/訊息)"
```

---

## Task 5: dashboard HTTP 伺服器 + 設定 + 進入點

**Files:**
- Modify: `src/config.js`
- Create: `src/dashboard/server.js`
- Create: `src/dashboard/index.js`
- Test: `test/dashboardServer.test.js`

- [ ] **Step 1: 建立 `test/dashboardServer.test.js`**

```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/dashboard/server");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

(async () => {
  const root = path.join(os.tmpdir(), `dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const queueDir = path.join(root, "queue");
  const storageDir = path.join(root, "storage");
  const outputFile = path.join(root, "output", "messages.jsonl");
  for (const s of ["pending", "done"]) fs.mkdirSync(path.join(queueDir, s), { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  fs.writeFileSync(path.join(storageDir, "rooms.json"), JSON.stringify({ "!r:s": "產品群" }), "utf8");
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), String(Date.now()), "utf8");
  fs.writeFileSync(path.join(queueDir, "done", "t1.json"), JSON.stringify({ rule: "會議", task: "cal", enqueued_at: "2026-06-26T01:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "hi", event_id: "$1" } }), "utf8");
  fs.appendFileSync(outputFile, JSON.stringify({ room_id: "!r:s", sender: "@a", body: "hello" }) + "\n", "utf8");

  const server = createServer({ queueDir, storageDir, outputFile });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  ok("tasks 回一筆", tasks.length === 1);
  ok("狀態 done", tasks[0].status === "done");
  ok("房間名稱翻譯", tasks[0].room_name === "產品群");

  const status = await (await fetch(`${base}/api/status`)).json();
  ok("bot 線上", status.bot_online === true);
  ok("done 計數 1", status.counts.done === 1);

  const msgs = await (await fetch(`${base}/api/messages`)).json();
  ok("messages 一筆", msgs.length === 1 && msgs[0].body === "hello");

  const log = await (await fetch(`${base}/api/tasks/t1/log`)).json();
  ok("日誌占位", log.source === "none");

  const html = await fetch(`${base}/`);
  ok("根路徑回 200", html.status === 200);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`dashboardServer.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node test/dashboardServer.test.js`
Expected: FAIL — `Cannot find module '../src/dashboard/server'`。

- [ ] **Step 3: 建立 `src/dashboard/server.js`**

```js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectTasks, statusCounts, resolveTaskLog, readMessagesTail } = require("./aggregate");
const { readRoomsMap } = require("../roomsSidecar");
const { readHeartbeat, isFresh } = require("../heartbeat");

const PUBLIC_DIR = path.join(__dirname, "public");
const HEARTBEAT_MAX_AGE_MS = 60000;
const TASKS_LIMIT = 100;
const MESSAGES_LIMIT = 50;

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// deps = { queueDir, storageDir, outputFile }
function createServer(deps) {
  const { queueDir, storageDir, outputFile } = deps;
  return http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    try {
      if (p === "/api/tasks") {
        return sendJson(res, 200, collectTasks(queueDir, readRoomsMap(storageDir), TASKS_LIMIT));
      }
      const logMatch = p.match(/^\/api\/tasks\/([^/]+)\/log$/);
      if (logMatch) {
        return sendJson(res, 200, resolveTaskLog(queueDir, decodeURIComponent(logMatch[1])));
      }
      if (p === "/api/messages") {
        return sendJson(res, 200, readMessagesTail(outputFile, MESSAGES_LIMIT));
      }
      if (p === "/api/status") {
        const hb = readHeartbeat(storageDir);
        return sendJson(res, 200, {
          bot_online: isFresh(hb, Date.now(), HEARTBEAT_MAX_AGE_MS),
          heartbeat_ts: hb,
          counts: statusCounts(queueDir),
        });
      }
      // 靜態檔(防目錄穿越)
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const full = path.join(PUBLIC_DIR, rel);
      if (!full.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      const data = fs.readFileSync(full);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(full)] || "application/octet-stream" });
      return res.end(data);
    } catch (_) {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

module.exports = { createServer };
```

- [ ] **Step 4: 在 `src/config.js` 的 `module.exports` 之前加入 `loadDashboardConfig`(不需 matrix 憑證,讓儀表板可獨立啟動)**

```js
// 儀表板專用設定:只需路徑與埠,不要求 matrix 憑證,讓 dashboard 能獨立啟動。
function loadDashboardConfig() {
  return {
    queueDir: path.resolve(__dirname, "..", process.env.QUEUE_DIR || "queue"),
    storageDir: path.resolve(__dirname, "..", "storage"),
    outputFile: path.resolve(__dirname, "..", "output", "messages.jsonl"),
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || "3000", 10),
  };
}
```

並把 `module.exports` 改成:

```js
module.exports = { loadConfig, parseRoomIds, loadDashboardConfig };
```

- [ ] **Step 5: 建立 `src/dashboard/index.js`**

```js
"use strict";
const { loadDashboardConfig } = require("../config");
const { createServer } = require("./server");

const config = loadDashboardConfig();
const server = createServer({
  queueDir: config.queueDir,
  storageDir: config.storageDir,
  outputFile: config.outputFile,
});
server.listen(config.dashboardPort, "127.0.0.1", () => {
  console.log(`[dashboard] 監控台已啟動 → http://127.0.0.1:${config.dashboardPort}`);
});
```

- [ ] **Step 6: 建立占位前端讓 server 測試的「根路徑回 200」通過**

建立 `src/dashboard/public/index.html`,內容暫時為:

```html
<!doctype html><meta charset="utf-8"><title>element-bot 監控台</title><p>placeholder</p>
```

(Task 6 會換成完整前端。)

- [ ] **Step 7: 執行測試確認通過**

Run: `node test/dashboardServer.test.js`
Expected: PASS — `dashboardServer.test.js: 8 項通過 ✅`。

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/dashboard/server.js src/dashboard/index.js src/dashboard/public/index.html test/dashboardServer.test.js
git commit -m "feat: dashboard HTTP 伺服器與進入點(綁 127.0.0.1)"
```

---

## Task 6: 前端單頁

**Files:**
- Modify: `src/dashboard/public/index.html`(覆蓋占位)

- [ ] **Step 1: 把 `src/dashboard/public/index.html` 內容整個換成**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>element-bot 監控台</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, "Microsoft JhengHei", sans-serif; background: #16181d; color: #e6e6e6; font-size: 14px; }
  header { padding: 10px 16px; background: #1c1f26; border-bottom: 1px solid #2c2f38; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header .dot { font-weight: bold; }
  header .counts span { margin-right: 10px; color: #aaa; }
  main { padding: 16px; }
  .dev { border: 1px dashed #555; border-radius: 8px; padding: 10px; margin-bottom: 18px; }
  .dev summary { cursor: pointer; color: #bbb; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2d36; vertical-align: top; }
  th { color: #9aa; font-weight: 600; }
  .split { display: flex; gap: 14px; }
  .tasks { flex: 1.5; }
  .detail { flex: 1; border-left: 1px solid #2a2d36; padding-left: 14px; min-width: 240px; }
  tr.task { cursor: pointer; }
  tr.task:hover { background: #1f232b; }
  tr.task.sel { background: #283041; }
  .badge { padding: 1px 8px; border-radius: 10px; color: #fff; font-size: 12px; }
  .pending { background: #9ca3af; } .processing { background: #3b82f6; } .done { background: #22c55e; } .failed { background: #ef4444; }
  pre { background: #0f1115; padding: 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
  .muted { color: #777; }
  .k { color: #889; display: inline-block; min-width: 64px; }
</style>
</head>
<body>
<header>
  <span class="dot" id="botStatus">…</span>
  <span class="counts" id="counts"></span>
</header>
<main>
  <details class="dev" open>
    <summary>🔧 監聽訊息（開發用,之後移除）</summary>
    <table><tbody id="msgs"></tbody></table>
  </details>

  <div class="split">
    <div class="tasks">
      <b>📋 觸發的任務</b>
      <table>
        <thead><tr><th>時間</th><th>聊天室</th><th>發送者</th><th>規則 → 任務</th><th>狀態</th></tr></thead>
        <tbody id="tasks"></tbody>
      </table>
    </div>
    <div class="detail">
      <b>🔎 任務詳情</b>
      <div id="detail" class="muted">點選左側任務以檢視詳情與日誌。</div>
    </div>
  </div>
</main>

<script>
const STATUS_LABEL = { pending: "待處理", processing: "進行中", done: "完成", failed: "失敗" };
let selectedId = null;
let lastTasks = [];

function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function timeOf(t) { return t ? new Date(t).toLocaleTimeString("zh-Hant", { hour12: false }) : "—"; }
function badge(s) { return `<span class="badge ${s}">${STATUS_LABEL[s] || s}</span>`; }

async function refresh() {
  try {
    const [status, tasks, msgs] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/tasks").then((r) => r.json()),
      fetch("/api/messages").then((r) => r.json()),
    ]);
    renderStatus(status);
    renderTasks(tasks);
    renderMsgs(msgs);
  } catch (e) {
    document.getElementById("botStatus").textContent = "🔴 儀表板無法連線";
  }
}

function renderStatus(s) {
  document.getElementById("botStatus").textContent = s.bot_online ? "🟢 bot 連線中" : "🔴 bot 離線";
  const c = s.counts || {};
  document.getElementById("counts").innerHTML =
    `<span>待處理 ${c.pending || 0}</span><span>進行中 ${c.processing || 0}</span><span>完成 ${c.done || 0}</span><span>失敗 ${c.failed || 0}</span>`;
}

function renderMsgs(msgs) {
  document.getElementById("msgs").innerHTML = (msgs || []).map((m) =>
    `<tr><td class="muted">${timeOf(m.origin_server_ts)}</td><td>${esc(m.room_id)}</td><td>${esc(m.sender)}</td><td>${esc(m.body)}</td></tr>`
  ).join("") || `<tr><td class="muted">（尚無訊息）</td></tr>`;
}

function renderTasks(tasks) {
  lastTasks = tasks || [];
  document.getElementById("tasks").innerHTML = lastTasks.map((t) => {
    if (t.parseError) return `<tr class="task" data-id="${esc(t.id)}"><td colspan="4" class="failed">⚠ 任務檔解析失敗:${esc(t.id)}</td><td>${badge(t.status)}</td></tr>`;
    return `<tr class="task ${t.id === selectedId ? "sel" : ""}" data-id="${esc(t.id)}">
      <td class="muted">${timeOf(t.enqueued_at)}</td><td>${esc(t.room_name)}</td><td>${esc(t.sender)}</td>
      <td>${esc(t.rule)} → ${esc(t.task)}</td><td>${badge(t.status)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">（尚無觸發的任務）</td></tr>`;

  document.querySelectorAll("tr.task").forEach((tr) => tr.addEventListener("click", () => selectTask(tr.dataset.id)));
  if (selectedId) renderDetail();
}

async function selectTask(id) {
  selectedId = id;
  document.querySelectorAll("tr.task").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === id));
  renderDetail();
}

async function renderDetail() {
  const t = lastTasks.find((x) => x.id === selectedId);
  const box = document.getElementById("detail");
  if (!t) { box.innerHTML = `<span class="muted">任務已不在列表中。</span>`; return; }
  let log = { source: "none", text: "（載入中…）" };
  try { log = await fetch(`/api/tasks/${encodeURIComponent(selectedId)}/log`).then((r) => r.json()); } catch (_) {}
  const logNote = log.source === "none" ? '<span class="muted">（executor 尚未寫入日誌）</span>' : "";
  box.innerHTML = `
    <div><span class="k">狀態</span> ${badge(t.status)}</div>
    <div><span class="k">聊天室</span> ${esc(t.room_name)}</div>
    <div><span class="k">發送者</span> ${esc(t.sender)}</div>
    <div><span class="k">規則</span> ${esc(t.rule)} → ${esc(t.task)}</div>
    <div><span class="k">來源訊息</span> ${esc(t.body)}</div>
    <div class="k" style="margin-top:8px">日誌 ${logNote}</div>
    <pre>${esc(log.text)}</pre>`;
}

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>
```

- [ ] **Step 2: 手動驗證(此為靜態前端,無自動化測試)**

啟動一個只供瀏覽的伺服器:`node src/dashboard/index.js`(需 `.env` 有 `QUEUE_DIR`/預設 queue 即可,不需 matrix 憑證)。
開 `http://127.0.0.1:3000`,確認:頁面載入、頂部顯示 bot 狀態與計數、任務表渲染、點任務右側顯示詳情與日誌占位、監聽訊息區可收合。若無資料,顯示「(尚無…)」字樣即算通過。Ctrl+C 結束。

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: dashboard 前端單頁(master-detail + 1.5s 輪詢)"
```

---

## Task 7: 串接 bot(heartbeat + rooms sidecar)與 npm scripts

**Files:**
- Modify: `src/index.js`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: 在 `src/index.js` 頂部 require 區加入**

```js
const path = require("path");
const { startHeartbeat } = require("./heartbeat");
const { writeRoomsSidecar, buildRoomEntries } = require("./roomsSidecar");
```

- [ ] **Step 2: 在 `src/index.js` 的 `main()` 內,`await waitForPrepared(client);` 之後加入 sidecar 與 heartbeat 串接**

```js
  const STORAGE_DIR = path.resolve(__dirname, "..", "storage");
  // 房間名稱 sidecar:PREPARED 後寫一次,之後房間改名時更新。
  const updateRooms = () => {
    try {
      writeRoomsSidecar(STORAGE_DIR, buildRoomEntries(client, config.roomIds));
    } catch (e) {
      console.warn("[element-bot] 寫 rooms.json 失敗:", e.message);
    }
  };
  updateRooms();
  client.on(sdk.RoomEvent.Name, updateRooms);
  // 心跳:每 30s 寫一次存活時間戳,供儀表板判斷 bot 是否在線。
  startHeartbeat(STORAGE_DIR, 30000);
```

- [ ] **Step 3: 改 `package.json`:`scripts` 加入 `dashboard`,並把 `test` 擴充為包含新測試**

`scripts` 區改為:

```json
  "scripts": {
    "start": "node src/index.js",
    "worker": "node src/worker.js",
    "dashboard": "node src/dashboard/index.js",
    "test": "node test/handler.test.js && node test/normalize.test.js && node test/rules.test.js && node test/matcher.test.js && node test/enqueue.test.js && node test/judge.test.js && node test/trigger.test.js && node test/dryRun.test.js && node test/workerCore.test.js && node test/heartbeat.test.js && node test/roomsSidecar.test.js && node test/aggregate.test.js && node test/dashboardServer.test.js"
  },
```

- [ ] **Step 4: 在 `.env.example` 末尾加入(若該檔不存在則建立並含此行)**

```
# 監控儀表板埠(僅綁 127.0.0.1)
DASHBOARD_PORT=3000
```

- [ ] **Step 5: 執行完整測試套件確認全綠**

Run: `npm test`
Expected: 每個測試檔印出 `... 項通過 ✅`,程序以 0 結束。

- [ ] **Step 6: Commit**

```bash
git add src/index.js package.json .env.example
git commit -m "feat: bot 串接 heartbeat 與 rooms sidecar,加 dashboard script"
```

---

## Task 8: 端到端煙霧測試(手動)

**Files:** 無(僅驗證)

- [ ] **Step 1: 用假資料驗證儀表板顯示**

在不啟動 bot 的情況下,手動造一筆任務與訊息:

```bash
mkdir -p queue/done storage output
echo '{"rule":"會議異動","task":"update_calendar","enqueued_at":"2026-06-26T03:00:00.000Z","source":{"room_id":"!demo:ims.opscloud.info","sender":"@alice:ims.opscloud.info","body":"明天會議改三點","event_id":"$demo"}}' > queue/done/demo.json
echo '{"!demo:ims.opscloud.info":"產品討論群"}' > storage/rooms.json
echo "$(node -e 'process.stdout.write(String(Date.now()))')" > storage/bot-heartbeat
echo '{"room_id":"!demo:ims.opscloud.info","sender":"@alice:ims.opscloud.info","body":"明天會議改三點","origin_server_ts":1781000000000}' >> output/messages.jsonl
```

- [ ] **Step 2: 啟動儀表板並檢查**

Run: `npm run dashboard`
開 `http://127.0.0.1:3000`,確認:
- 頂部顯示「🟢 bot 連線中」與「完成 1」。
- 任務表出現一列,聊天室顯示「產品討論群」(非 room_id),狀態徽章「完成」。
- 點該列,右側詳情顯示來源訊息,日誌區顯示「executor 尚未寫入日誌」。
- 監聽訊息區出現一筆。
Ctrl+C 結束。

- [ ] **Step 3: 清掉煙霧測試假資料**

```bash
rm -f queue/done/demo.json storage/rooms.json storage/bot-heartbeat
```

(註:`output/messages.jsonl` 與 `storage/bot-heartbeat` 等屬 gitignore,不影響 git。)

- [ ] **Step 4: 最終提交(若上述驗證有任何手動微調)**

```bash
git status
# 若有未提交的修正:
git add -A && git commit -m "chore: dashboard 端到端驗證後微調"
```

---

## 自我審查紀錄

- **Spec 覆蓋**:方案 A 三程序(Task 5/6/7)、processing/ 流轉(Task 1)、rooms.json(Task 3+7)、heartbeat(Task 2+7)、日誌約定占位(Task 4 `resolveTaskLog`)、輪詢 1.5s(Task 6)、127.0.0.1 綁定(Task 5)、四 API(Task 5)、版面(Task 6)、錯誤容錯(Task 4 parseError / Task 5 try-catch)、測試(各 Task)、dev 監聽區可收合(Task 6)。皆有對應任務。
- **型別一致**:`collectTasks/statusCounts/resolveTaskLog/readMessagesTail` 簽章在 Task 4 定義,Task 5 server、Task 6 前端使用一致;任務檢視物件欄位(id/status/rule/task/room_name/sender/body/enqueued_at)前後一致。
- **不在範圍**:requeue、並發/逾時、真正 executor 日誌格式 — 未排入,符合 spec。
