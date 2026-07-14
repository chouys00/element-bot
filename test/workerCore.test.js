"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { processOne, pollOnce, recoverProcessing } = require("../src/workerCore");

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

  for (const status of ["blocked", "review", "failed"]) {
    const q = freshQueue();
    const f = writePending(q, `${status}.json`, { rule: "r", task: "t", params: {} });
    const notes = [];
    const res = await processOne(f, {
      queueDir: q,
      executor: async () => ({ queueStatus: status, summary: status }),
      logger: silentLogger,
      notify: async (info) => notes.push(info),
    });
    ok(`結構化 ${status} 回傳相同狀態`, res === status);
    ok(`結構化 ${status} 移到對應目錄`, fs.existsSync(path.join(q, status, `${status}.json`)));
    ok(`結構化 ${status} 通知狀態一致`, notes.length === 1 && notes[0].status === status);
    ok(`結構化 ${status} 不寫基礎設施錯誤檔`, !fs.existsSync(path.join(q, status, `${status}.json.error.txt`)));
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

  // recoverProcessing 崩潰重試保險:attempt 未達上限→回收;達上限→送 failed/ 不再重撿
  {
    const q = freshQueue();
    fs.mkdirSync(path.join(q, "processing"), { recursive: true });
    // 未達上限(attempt=2 < 3):應回收回 pending/
    fs.writeFileSync(path.join(q, "processing", "young.json"), JSON.stringify({ rule: "r", task: "t" }), "utf8");
    fs.mkdirSync(path.join(q, "work", "young"), { recursive: true });
    fs.writeFileSync(path.join(q, "work", "young", "state.json"), JSON.stringify({ attempt: 2 }), "utf8");
    // 已達上限(attempt=3 >= 3):應放棄 → failed/
    fs.writeFileSync(path.join(q, "processing", "looper.json"), JSON.stringify({ rule: "r", task: "t" }), "utf8");
    fs.mkdirSync(path.join(q, "work", "looper"), { recursive: true });
    fs.writeFileSync(path.join(q, "work", "looper", "state.json"), JSON.stringify({ attempt: 3 }), "utf8");

    const n = recoverProcessing(q, silentLogger, 3);
    ok("只回收未達上限者(回傳 1)", n === 1);
    ok("未達上限任務回 pending/", fs.existsSync(path.join(q, "pending", "young.json")));
    ok("達上限任務移入 failed/", fs.existsSync(path.join(q, "failed", "looper.json")));
    ok("達上限任務不回 pending/", !fs.existsSync(path.join(q, "pending", "looper.json")));
    ok("達上限任務有寫 .error.txt", fs.existsSync(path.join(q, "failed", "looper.json.error.txt")));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // processOne 成功/失敗都應呼叫 deps.notify,帶正確 status/id/task
  {
    const q = freshQueue();
    const f = writePending(q, "n1.json", { rule: "r", task: "t", params: {} });
    const notes = [];
    await processOne(f, { queueDir: q, executor: async () => {}, logger: silentLogger, notify: async (info) => notes.push(info) });
    ok("成功有通知", notes.length === 1 && notes[0].status === "done");
    ok("通知帶 id", notes[0].id === "n1");
    ok("通知帶 task 物件", notes[0].task && notes[0].task.task === "t");
    fs.rmSync(q, { recursive: true, force: true });
  }
  {
    const q = freshQueue();
    const f = writePending(q, "n2.json", { rule: "r", task: "t", params: {} });
    const notes = [];
    await processOne(f, { queueDir: q, executor: async () => { throw new Error("boom"); }, logger: silentLogger, notify: async (info) => notes.push(info) });
    ok("失敗有通知", notes.length === 1 && notes[0].status === "failed");
    ok("失敗通知帶 error", notes[0].error === "boom");
    fs.rmSync(q, { recursive: true, force: true });
  }
  // notify 丟錯不應影響任務結果(仍 done)
  {
    const q = freshQueue();
    const f = writePending(q, "n3.json", { rule: "r", task: "t", params: {} });
    const res = await processOne(f, { queueDir: q, executor: async () => {}, logger: silentLogger, notify: async () => { throw new Error("notify fail"); } });
    ok("通知失敗不影響任務結果", res === "done");
    ok("任務仍在 done/", fs.existsSync(path.join(q, "done", "n3.json")));
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

  console.log(`workerCore.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
