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
    summarize: async () => { calls.push("summarize"); return { status: "OK", summary: "done", needsReview: ["X"] }; },
  };
}

(async () => {
  // 全新任務:四步都跑,log 有 steps 宣告 + 各步 ok + 總結
  {
    const q = freshQueue();
    const calls = [];
    const result = await agentExecutor({ task: "t" }, { queueDir: q, id: "j1", logger: silentLogger, handlers: fakeHandlers(calls) });
    ok("四步都跑", calls.join(",") === "prepare,ai_run,verify,summarize");
    const lines = readLogLines(q, "j1");
    ok("有 steps 宣告", lines.some((o) => Array.isArray(o.steps)));
    ok("有總結 OK", lines.some((o) => o.status === "OK" && o.summary === "done"));
    ok("executor 回傳 summarize 結果", result && result.status === "OK" && result.summary === "done");
    const st = readState(path.join(q, "work", "j1"));
    ok("state 全 ok", st && Object.values(st.steps).every((v) => v === "ok"));
    fs.rmSync(q, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
    fs.rmSync(q, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
    fs.rmSync(q, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  console.log(`agentExecutor.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
