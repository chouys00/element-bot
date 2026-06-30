"use strict";
const assert = require("assert");
const { make } = require("../src/executors/defaultHandlers");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
const noop = () => {};

(async () => {
  // prepare:唯讀檢查本體 git 乾淨(呼叫 gitClean),不複製
  {
    const calls = [];
    const ops = { gitClean: () => calls.push("git"), runClaude: () => calls.push("claude"), runVerify: () => ({ errors: 0 }), gitChanged: () => [] };
    const h = make(ops);
    await h.prepare({ task: { task: "demo-skill" }, emit: noop, shared: {} });
    ok("prepare 只 gitClean、不複製", calls.join(",") === "git");
  }

  // ai_run:把 claude 帶進真實專案,prompt 指向 SKILL.md、cwd 為目標專案
  {
    let prompt = null, cwd = null;
    const ops = { gitClean: () => {}, runClaude: (p, dir) => { prompt = p; cwd = dir; }, runVerify: () => ({ errors: 0 }), gitChanged: () => [] };
    const h = make(ops);
    await h.ai_run({ task: { task: "demo-skill", source: { body: "把背景改成紅色" } }, emit: noop, shared: {} });
    ok("ai_run 呼叫 claude", prompt !== null);
    ok("ai_run prompt 指向 SKILL.md", typeof prompt === "string" && prompt.includes("SKILL.md"));
    ok("ai_run cwd 為目標專案(sample-app)", typeof cwd === "string" && cwd.endsWith("sample-app"));
  }

  // verify:verifyArgs null → 直接 errors:0,不呼叫 runVerify
  {
    let verifyCalled = false;
    const ops = { gitClean: () => {}, runClaude: () => {}, runVerify: () => { verifyCalled = true; return { errors: 0 }; }, gitChanged: () => ["index.html"] };
    const h = make(ops);
    const shared = {};
    await h.verify({ task: { task: "demo-skill" }, emit: noop, shared });
    ok("demo-skill verifyArgs null 不呼叫 runVerify", verifyCalled === false && shared.verify.errors === 0);
  }

  // summarize:本體有改動 + verify errors=0 → OK
  {
    const ops = { gitClean: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 0 }), gitChanged: () => ["index.html"] };
    const h = make(ops);
    const shared = {};
    await h.verify({ task: { task: "demo-skill" }, emit: noop, shared });
    const sum = await h.summarize({ task: { task: "demo-skill" }, emit: noop, shared });
    ok("有改動 → OK", sum.status === "OK" && sum.produced.includes("index.html"));
    ok("OK 帶 needsReview", Array.isArray(sum.needsReview));
  }

  // summarize:本體無改動 → ERROR(SKILL 沒做事)
  {
    const ops = { gitClean: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 0 }), gitChanged: () => [] };
    const h = make(ops);
    const sum = await h.summarize({ task: { task: "demo-skill" }, emit: noop, shared: {} });
    ok("無改動 → ERROR", sum.status === "ERROR");
  }

  // summarize:有改動但 verify errors>0 → NEEDS(用 i18n-skill,有 verifyArgs)
  {
    const ops = { gitClean: () => {}, runClaude: () => {}, runVerify: () => ({ errors: 3, warnings: 0 }), gitChanged: () => ["i18n/zh_CN.json"] };
    const h = make(ops);
    const task = { task: "i18n-skill", params: { 站點: "siteA" } };
    const shared = {};
    await h.verify({ task, emit: noop, shared });
    const sum = await h.summarize({ task, emit: noop, shared });
    ok("verify errors>0 → NEEDS", sum.status === "NEEDS");
  }

  console.log(`defaultHandlers.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
