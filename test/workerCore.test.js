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

  {
    const q = freshQueue();
    const f = writePending(q, "b.json", { rule: "r", task: "t", params: {} });
    const res = await processOne(f, { queueDir: q, executor: async () => { throw new Error("boom"); }, logger: silentLogger });
    ok("失敗回傳 failed", res === "failed");
    ok("檔案在 failed/", fs.existsSync(path.join(q, "failed", "b.json")));
    ok("有寫 .error.txt", fs.existsSync(path.join(q, "failed", "b.json.error.txt")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  {
    const q = freshQueue();
    const p = path.join(q, "pending", "c.json");
    fs.writeFileSync(p, "{ not json", "utf8");
    const res = await processOne(p, { queueDir: q, executor: async () => {}, logger: silentLogger });
    ok("壞 JSON 回傳 failed", res === "failed");
    ok("壞 JSON 移到 failed/", fs.existsSync(path.join(q, "failed", "c.json")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  {
    const q = freshQueue();
    writePending(q, "1.json", { rule: "r", task: "t", params: {} });
    writePending(q, "2.json", { rule: "r", task: "t", params: {} });
    const n = await pollOnce({ queueDir: q, executor: async () => {}, logger: silentLogger });
    ok("pollOnce 回傳處理筆數", n === 2);
    ok("pending 已清空", fs.readdirSync(path.join(q, "pending")).filter((f) => f.endsWith(".json")).length === 0);
    fs.rmSync(q, { recursive: true, force: true });
  }

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

  console.log(`workerCore.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
