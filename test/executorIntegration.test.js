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
  const d = path.join(os.tmpdir(), `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 用真實 taskDef "demo-skill";sourceDir 只組路徑、不真存取,假 ops 不會碰磁碟。
const TASK = { task: "demo-skill", source: { body: "把背景改成紅色" } };
const findSummary = (lines) => lines.find((o) => typeof o.status === "string" && !o.step && !o.steps);

(async () => {
  // 全新任務跑完整鏈(真實 handlers + 假 ops):claude 改本體 → git 有改動 → summary OK
  {
    const q = freshQueue();
    const calls = [];
    const ops = {
      gitClean: () => calls.push("git"),
      runClaude: () => calls.push("claude"),
      runVerify: () => ({ errors: 0, warnings: 0 }),
      gitChanged: () => ["index.html"],
    };
    await agentExecutor(TASK, { queueDir: q, id: "f1", logger: silentLogger, ops });
    ok("完整鏈呼叫順序 git,claude(不複製)", calls.join(",") === "git,claude");
    const summary = findSummary(readLogLines(q, "f1"));
    ok("summary OK", summary && summary.status === "OK");
    ok("summary 含改動檔", summary && summary.produced.includes("index.html"));
    const st = readState(path.join(q, "work", "f1"));
    ok("state 全 ok", st && Object.values(st.steps).every((v) => v === "ok"));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // 中斷續跑:state 預seed prepare ok → 跳過 prepare(不再 gitClean),ai_run 重跑 claude
  {
    const q = freshQueue();
    const workDir = path.join(q, "work", "f2");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "state.json"),
      JSON.stringify({ id: "f2", steps: { prepare: "ok", ai_run: "pending", verify: "pending", summarize: "pending" }, attempt: 1 }), "utf8");
    const calls = [];
    const ops = {
      gitClean: () => calls.push("git"),
      runClaude: () => calls.push("claude"),
      runVerify: () => ({ errors: 0 }),
      gitChanged: () => ["index.html"],
    };
    await agentExecutor(TASK, { queueDir: q, id: "f2", logger: silentLogger, ops });
    ok("續跑跳過 prepare(不再 gitClean)", !calls.includes("git"));
    ok("續跑重跑 ai_run(claude 被呼叫)", calls.includes("claude"));
    ok("續跑仍出 OK summary", (findSummary(readLogLines(q, "f2")) || {}).status === "OK");
    fs.rmSync(q, { recursive: true, force: true });
  }

  // shared.verify 由 verify 流到 summarize:errors>0 → NEEDS(用有 verifyArgs 的 i18n-skill)
  {
    const q = freshQueue();
    const ops = {
      gitClean: () => {},
      runClaude: () => {},
      runVerify: () => ({ errors: 2, warnings: 0 }),
      gitChanged: () => ["i18n/zh_CN.json"],
    };
    await agentExecutor({ task: "i18n-skill", params: { "站點": "siteA" } }, { queueDir: q, id: "f3", logger: silentLogger, ops });
    ok("verify errors>0 流到 summary → NEEDS", (findSummary(readLogLines(q, "f3")) || {}).status === "NEEDS");
    fs.rmSync(q, { recursive: true, force: true });
  }

  console.log(`executorIntegration.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
