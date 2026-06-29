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
const ARTIFACT = "i18n/zh_CN.json";
function writeArtifact(copyDir) {
  fs.mkdirSync(path.join(copyDir, "i18n"), { recursive: true });
  fs.writeFileSync(path.join(copyDir, ARTIFACT), "{}", "utf8");
}
// 用真實 taskDef "i18n-skill";站點在 FTL_ROOT 內即可(copyTree 被假掉,不會真存取)
const TASK = { task: "i18n-skill", params: { "站點": "siteA" } };
const findSummary = (lines) => lines.find((o) => typeof o.status === "string" && !o.step && !o.steps);

(async () => {
  // 全新任務跑完整鏈(真實 handlers + 假 ops):claude 寫出產物 → verify 0 → summary OK
  {
    const q = freshQueue();
    const calls = [];
    const ops = {
      gitClean: () => calls.push("git"),
      copyTree: (src, dest) => { calls.push("copy"); fs.mkdirSync(dest, { recursive: true }); },
      runClaude: (prompt, copyDir) => { calls.push("claude"); writeArtifact(copyDir); },
      runVerify: () => ({ errors: 0, warnings: 0 }),
    };
    await agentExecutor(TASK, { queueDir: q, id: "f1", logger: silentLogger, ops });
    ok("完整鏈呼叫順序 git,copy,claude", calls.join(",") === "git,copy,claude");
    const summary = findSummary(readLogLines(q, "f1"));
    ok("summary OK", summary && summary.status === "OK");
    ok("summary 含產物", summary && summary.produced.includes(ARTIFACT));
    const st = readState(path.join(q, "work", "f1"));
    ok("state 全 ok", st && Object.values(st.steps).every((v) => v === "ok"));
    fs.rmSync(q, { recursive: true, force: true });
  }

  // 中斷續跑:state 預seed prepare ok、產物已存在 → 跳過 prepare(不 copy)且跳過 claude
  {
    const q = freshQueue();
    const workDir = path.join(q, "work", "f2");
    const copyDir = path.join(workDir, "copy");
    writeArtifact(copyDir); // 產物已在(上次 claude 跑出來的)
    fs.writeFileSync(path.join(workDir, "state.json"),
      JSON.stringify({ id: "f2", steps: { prepare: "ok", ai_run: "pending", verify: "pending", summarize: "pending" }, attempt: 1 }), "utf8");
    const calls = [];
    const ops = {
      gitClean: () => calls.push("git"),
      copyTree: () => calls.push("copy"),
      runClaude: () => { calls.push("claude"); throw new Error("claude 不該被呼叫"); },
      runVerify: () => ({ errors: 0 }),
    };
    await agentExecutor(TASK, { queueDir: q, id: "f2", logger: silentLogger, ops });
    ok("續跑跳過 prepare(無 git/copy)", !calls.includes("copy") && !calls.includes("git"));
    ok("產物已存在跳過 claude", !calls.includes("claude"));
    ok("續跑仍出 OK summary", (findSummary(readLogLines(q, "f2")) || {}).status === "OK");
    fs.rmSync(q, { recursive: true, force: true });
  }

  // shared.verify 由 verify 流到 summarize:errors>0 → NEEDS
  {
    const q = freshQueue();
    const ops = {
      gitClean: () => {},
      copyTree: (src, dest) => { fs.mkdirSync(dest, { recursive: true }); writeArtifact(dest); },
      runClaude: () => {},
      runVerify: () => ({ errors: 2, warnings: 0 }),
    };
    await agentExecutor(TASK, { queueDir: q, id: "f3", logger: silentLogger, ops });
    ok("verify errors>0 流到 summary → NEEDS", (findSummary(readLogLines(q, "f3")) || {}).status === "NEEDS");
    fs.rmSync(q, { recursive: true, force: true });
  }

  console.log(`executorIntegration.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
