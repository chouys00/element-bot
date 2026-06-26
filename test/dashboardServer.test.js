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
  ok("messages 房間名稱已翻譯", msgs[0].room_name === "產品群");

  const log = await (await fetch(`${base}/api/tasks/t1/log`)).json();
  ok("日誌占位", log.source === "none");

  const html = await fetch(`${base}/`);
  ok("根路徑回 200", html.status === 200);

  const traversal = await fetch(`${base}/api/tasks/..%2F..%2Fsecret/log`);
  ok("log 端點擋路徑穿越(400)", traversal.status === 400);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`dashboardServer.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
