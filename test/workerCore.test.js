"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { processOne, pollOnce, recoverProcessing } = require("../src/workerCore");

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
}

const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const dir = path.join(os.tmpdir(), `wq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(dir, "pending"), { recursive: true });
  return dir;
}

function writePending(queueDir, name, value) {
  const file = path.join(queueDir, "pending", name);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

(async () => {
  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "a.json", { rule: "r", task: "t", params: {} });
    const ran = [];
    const status = await processOne(file, {
      queueDir,
      executor: async (task) => { ran.push(task); return { queueStatus: "done" }; },
      logger: silentLogger,
    });
    ok("成功回傳 done", status === "done");
    ok("executor 有被呼叫", ran.length === 1);
    ok("原檔已移走", !fs.existsSync(file));
    ok("檔案在 done/", fs.existsSync(path.join(queueDir, "done", "a.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "empty-result.json", { rule: "r", task: "t", params: {} });
    const status = await processOne(file, {
      queueDir,
      executor: async () => null,
      logger: silentLogger,
    });
    ok("executor 空結果回傳 failed", status === "failed");
    ok("executor 空結果移到 failed/", fs.existsSync(path.join(queueDir, "failed", "empty-result.json")));
    ok("executor 空結果留下錯誤紀錄", fs.existsSync(path.join(queueDir, "failed", "empty-result.json.error.txt")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "b.json", { rule: "r", task: "t", params: {} });
    const status = await processOne(file, {
      queueDir,
      executor: async () => { throw new Error("boom"); },
      logger: silentLogger,
    });
    ok("失敗回傳 failed", status === "failed");
    ok("檔案在 failed/", fs.existsSync(path.join(queueDir, "failed", "b.json")));
    ok("有寫 .error.txt", fs.existsSync(path.join(queueDir, "failed", "b.json.error.txt")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  for (const expected of ["blocked", "review", "failed"]) {
    const queueDir = freshQueue();
    const file = writePending(queueDir, `${expected}.json`, { rule: "r", task: "t", params: {} });
    const notes = [];
    const status = await processOne(file, {
      queueDir,
      executor: async () => ({ queueStatus: expected, summary: expected }),
      logger: silentLogger,
      notify: async (info) => notes.push(info),
    });
    ok(`結構化 ${expected} 回傳相同狀態`, status === expected);
    ok(`結構化 ${expected} 移到對應目錄`, fs.existsSync(path.join(queueDir, expected, `${expected}.json`)));
    ok(`結構化 ${expected} 通知狀態一致`, notes.length === 1 && notes[0].status === expected);
    ok(`結構化 ${expected} 不寫基礎設施錯誤檔`, !fs.existsSync(path.join(queueDir, expected, `${expected}.json.error.txt`)));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = path.join(queueDir, "pending", "c.json");
    fs.writeFileSync(file, "{ not json", "utf8");
    const status = await processOne(file, { queueDir, executor: async () => {}, logger: silentLogger });
    ok("壞 JSON 回傳 failed", status === "failed");
    ok("壞 JSON 移到 failed/", fs.existsSync(path.join(queueDir, "failed", "c.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    writePending(queueDir, "1.json", { rule: "r", task: "t", params: {} });
    writePending(queueDir, "2.json", { rule: "r", task: "t", params: {} });
    const count = await pollOnce({
      queueDir,
      executor: async () => ({ queueStatus: "done" }),
      logger: silentLogger,
    });
    ok("pollOnce 每輪只處理一筆", count === 1);
    ok("第一筆移入 done/", fs.existsSync(path.join(queueDir, "done", "1.json")));
    ok("第二筆保留在 pending/", fs.existsSync(path.join(queueDir, "pending", "2.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "p.json", { rule: "r", task: "t", params: {} });
    let sawProcessing = false;
    await processOne(file, {
      queueDir,
      executor: async () => {
        sawProcessing = fs.existsSync(path.join(queueDir, "processing", "p.json"));
        return { queueStatus: "done" };
      },
      logger: silentLogger,
    });
    ok("執行期間檔案在 processing/", sawProcessing);
    ok("完成後移到 done/", fs.existsSync(path.join(queueDir, "done", "p.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    fs.mkdirSync(path.join(queueDir, "processing"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "processing", "x.json"), JSON.stringify({ rule: "r", task: "t", params: {} }), "utf8");
    let ran = 0;
    const count = await pollOnce({
      queueDir,
      executor: async () => { ran++; },
      logger: silentLogger,
    });
    ok("pollOnce 不處理 processing/", ran === 0 && count === 0);
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    fs.mkdirSync(path.join(queueDir, "processing"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "processing", "stuck.json"), JSON.stringify({ rule: "r", task: "t" }), "utf8");
    const count = recoverProcessing(queueDir, silentLogger);
    ok("回收回傳筆數", count === 1);
    ok("已搬回 pending/", fs.existsSync(path.join(queueDir, "pending", "stuck.json")));
    ok("processing/ 已清空", !fs.existsSync(path.join(queueDir, "processing", "stuck.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    fs.mkdirSync(path.join(queueDir, "processing"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "processing", "young.json"), JSON.stringify({ rule: "r", task: "t" }), "utf8");
    fs.mkdirSync(path.join(queueDir, "work", "young"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "work", "young", "state.json"), JSON.stringify({ attempt: 2 }), "utf8");
    fs.writeFileSync(path.join(queueDir, "processing", "looper.json"), JSON.stringify({ rule: "r", task: "t" }), "utf8");
    fs.mkdirSync(path.join(queueDir, "work", "looper"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "work", "looper", "state.json"), JSON.stringify({ attempt: 3 }), "utf8");

    const count = recoverProcessing(queueDir, silentLogger, 3);
    ok("只回收未達上限者", count === 1);
    ok("未達上限任務回 pending/", fs.existsSync(path.join(queueDir, "pending", "young.json")));
    ok("達上限任務移入 failed/", fs.existsSync(path.join(queueDir, "failed", "looper.json")));
    ok("達上限任務不回 pending/", !fs.existsSync(path.join(queueDir, "pending", "looper.json")));
    ok("達上限任務有寫 .error.txt", fs.existsSync(path.join(queueDir, "failed", "looper.json.error.txt")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "n1.json", { rule: "r", task: "t", params: {} });
    const notes = [];
    await processOne(file, {
      queueDir,
      executor: async () => ({ queueStatus: "done" }),
      logger: silentLogger,
      notify: async (info) => notes.push(info),
    });
    ok("成功有通知", notes.length === 1 && notes[0].status === "done");
    ok("通知帶 id", notes[0].id === "n1");
    ok("通知帶 task 物件", notes[0].task && notes[0].task.task === "t");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "n2.json", { rule: "r", task: "t", params: {} });
    const notes = [];
    await processOne(file, {
      queueDir,
      executor: async () => { throw new Error("boom"); },
      logger: silentLogger,
      notify: async (info) => notes.push(info),
    });
    ok("失敗有通知", notes.length === 1 && notes[0].status === "failed");
    ok("失敗通知帶 error", notes[0].error === "boom");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "n3.json", { rule: "r", task: "t", params: {} });
    const status = await processOne(file, {
      queueDir,
      executor: async () => ({ queueStatus: "done" }),
      logger: silentLogger,
      notify: async () => { throw new Error("notify fail"); },
    });
    ok("通知失敗不影響任務結果", status === "done");
    ok("任務仍在 done/", fs.existsSync(path.join(queueDir, "done", "n3.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = writePending(queueDir, "withid.json", { rule: "r", task: "t" });
    let seen = null;
    await processOne(file, {
      queueDir,
      executor: async (_task, context) => {
        seen = context;
        return { queueStatus: "done" };
      },
      logger: silentLogger,
    });
    ok("executor 收到 id", seen && seen.id === "withid");
    ok("executor 收到 queueDir", seen && seen.queueDir === queueDir);
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  console.log(`workerCore.test.js: ${passed} 項通過 ✅`);
})().catch((error) => { console.error(error); process.exit(1); });
