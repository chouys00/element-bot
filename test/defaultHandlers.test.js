"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { make } = require("../src/executors/defaultHandlers");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshWork() {
  const d = path.join(os.tmpdir(), `dh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(d, "copy"), { recursive: true });
  return d;
}
const noop = () => {};

(async () => {
  // ai_run:產物已存在 → 不呼叫 claude
  {
    const workDir = freshWork();
    fs.mkdirSync(path.join(workDir, "copy", "i18n"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "copy", "i18n", "zh_CN.json"), "{}", "utf8");
    let claudeCalled = false;
    const ops = { gitClean: () => {}, copyTree: () => {}, runClaude: () => { claudeCalled = true; }, runVerify: () => ({ errors: 0, warnings: 0 }) };
    const h = make(ops);
    await h.ai_run({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: {} });
    ok("產物已存在不跑 claude", claudeCalled === false);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  // ai_run:產物不存在 → 呼叫 claude
  {
    const workDir = freshWork();
    let claudeCalled = false;
    const ops = { gitClean: () => {}, copyTree: () => {}, runClaude: () => { claudeCalled = true; }, runVerify: () => ({ errors: 0, warnings: 0 }) };
    const h = make(ops);
    await h.ai_run({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: {} });
    ok("產物缺則跑 claude", claudeCalled === true);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  // verify errors>0 → summarize 回 NEEDS;errors=0 → OK
  {
    const workDir = freshWork();
    fs.mkdirSync(path.join(workDir, "copy", "i18n"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "copy", "i18n", "zh_CN.json"), "{}", "utf8");
    const shared = {};
    const okOps = { gitClean: () => {}, copyTree: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 0, warnings: 1 }) };
    let h = make(okOps);
    await h.verify({ workDir, task: { task: "i18n-skill" }, emit: noop, shared });
    let sum = await h.summarize({ workDir, task: { task: "i18n-skill" }, emit: noop, shared });
    ok("errors=0 → OK", sum.status === "OK" && Array.isArray(sum.needsReview));

    const badOps = { gitClean: () => {}, copyTree: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 3, warnings: 0 }) };
    const shared2 = {};
    h = make(badOps);
    await h.verify({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: shared2 });
    sum = await h.summarize({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: shared2 });
    ok("errors>0 → NEEDS", sum.status === "NEEDS");
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  // prepare:呼叫 gitClean 再 copyTree
  {
    const workDir = freshWork();
    const order = [];
    const ops = { gitClean: () => order.push("git"), copyTree: () => order.push("copy"), runClaude: () => {}, runVerify: () => ({ errors: 0 }) };
    const h = make(ops);
    await h.prepare({ workDir, task: { task: "i18n-skill" }, emit: noop, shared: {} });
    ok("prepare 先 git 再 copy", order.join(",") === "git,copy");
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`defaultHandlers.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
