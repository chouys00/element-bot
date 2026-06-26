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
