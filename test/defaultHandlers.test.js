"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

  // prepare:記下起跑 HEAD 到 workDir/base.json(供 summarize 偵測自行 commit)
  {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-"));
    const ops = { gitClean: () => {}, gitHead: () => "abc123", runClaude: () => "", runVerify: () => ({ errors: 0 }), gitChanged: () => [] };
    const h = make(ops);
    await h.prepare({ workDir, task: { task: "demo-skill" }, emit: noop, shared: {} });
    const base = JSON.parse(fs.readFileSync(path.join(workDir, "base.json"), "utf8"));
    ok("prepare 記下起跑 HEAD", base.head === "abc123");
  }

  // ai_run:claude 的 stdout 進 log(emit ai_output)
  {
    const emitted = [];
    const ops = { gitClean: () => {}, runClaude: () => "我改了 index.html 的背景色", runVerify: () => ({ errors: 0 }), gitChanged: () => [] };
    const h = make(ops);
    await h.ai_run({ task: { task: "demo-skill", source: { body: "x" } }, emit: (o) => emitted.push(o), shared: {} });
    const out = emitted.find((o) => typeof o.ai_output === "string");
    ok("ai_run 把 claude 輸出 emit 進 log", out && out.ai_output.includes("背景色"));
  }

  // ai_run:超長輸出截尾(保留結尾)
  {
    const emitted = [];
    const long = "x".repeat(9000) + "結尾";
    const ops = { gitClean: () => {}, runClaude: () => long, runVerify: () => ({ errors: 0 }), gitChanged: () => [] };
    const h = make(ops);
    await h.ai_run({ task: { task: "demo-skill", source: { body: "x" } }, emit: (o) => emitted.push(o), shared: {} });
    const out = emitted.find((o) => typeof o.ai_output === "string");
    ok("超長輸出截尾且保留結尾", out.ai_output.length <= 8000 && out.ai_output.endsWith("結尾"));
  }

  // summarize:工作區乾淨但 skill 以 commit 收尾(可能是 skill 文件要求)→ 如實回報(不誤判 ERROR)
  {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-"));
    fs.writeFileSync(path.join(workDir, "base.json"), JSON.stringify({ head: "base00" }), "utf8");
    const ops = {
      gitClean: () => {}, runClaude: () => "", runVerify: () => ({ errors: 0 }),
      gitChanged: () => [], // 工作區乾淨(改動被 commit 掉了)
      gitHead: () => "new111",
      gitCommitsSince: () => ({ commits: ["new111 test: 優惠辦理域名更換"], files: ["src/a.js", "src/b.js"] }),
    };
    const h = make(ops);
    const sum = await h.summarize({ workDir, task: { task: "demo-skill" }, emit: noop, shared: {} });
    ok("commit 收尾 → 不誤判 ERROR", sum.status === "OK");
    ok("commit 收尾 → summary 指出已 commit", sum.summary.includes("commit"));
    ok("commit 收尾 → produced 為 commit 涉及檔案", sum.produced.includes("src/a.js"));
    ok("commit 收尾 → needsReview 提醒確認 commit 是否為 skill 要求", sum.needsReview.some((n) => n.includes("commit")));
  }

  // summarize:工作區乾淨且 HEAD 未動 → 仍為 ERROR(真的沒做事)
  {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-"));
    fs.writeFileSync(path.join(workDir, "base.json"), JSON.stringify({ head: "base00" }), "utf8");
    const ops = {
      gitClean: () => {}, runClaude: () => "", runVerify: () => ({ errors: 0 }),
      gitChanged: () => [], gitHead: () => "base00", gitCommitsSince: () => ({ commits: [], files: [] }),
    };
    const h = make(ops);
    const sum = await h.summarize({ workDir, task: { task: "demo-skill" }, emit: noop, shared: {} });
    ok("無改動且 HEAD 未動 → ERROR", sum.status === "ERROR");
  }

  console.log(`defaultHandlers.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
