"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { make } = require("../src/executors/defaultHandlers");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
const noop = () => {};
const TASK = { task: "skill-dispatch", project_path: "D:\\GB\\sample-app", command: "分析專案" };
const result = (status, summary = "完成") => ({
  status, summary, changes: [], validation: [], commits: [], warnings: [],
});

function freshWork() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dh-"));
}

(async () => {
  {
    let cleanCalled = false;
    const workDir = freshWork();
    const h = make({ gitClean: () => { cleanCalled = true; }, gitHead: () => "abc123" });
    await h.prepare({ workDir, task: TASK, emit: noop, shared: {} });
    ok("prepare 不要求 git clean", cleanCalled === false);
    ok("prepare 可記錄起始 HEAD 作觀測", JSON.parse(fs.readFileSync(path.join(workDir, "base.json"), "utf8")).head === "abc123");
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  {
    const workDir = freshWork();
    const emitted = [];
    const expected = result("success", "分析完成，不需改檔");
    const h = make({ runCodex: async () => JSON.stringify(expected) });
    await h.ai_run({ workDir, task: TASK, emit: (o) => emitted.push(o), shared: {} });
    ok("ai_run 持久化結構化結果", JSON.parse(fs.readFileSync(path.join(workDir, "task-result.json"), "utf8")).summary === expected.summary);
    ok("ai_run 保留 Codex 輸出供 dashboard 顯示", emitted.some((o) => typeof o.ai_output === "string" && o.ai_output.includes(expected.summary)));
    const sum = await h.summarize({ workDir, task: TASK, emit: noop, shared: {} });
    ok("checkpoint 續跑可從檔案還原結果", sum.summary === expected.summary);
    ok("無 git diff 的 success 仍成功", sum.status === "success" && sum.queueStatus === "done");
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  for (const [status, expectedQueue] of [["failed", "failed"], ["blocked", "blocked"], ["partial", "review"]]) {
    const workDir = freshWork();
    const h = make({ runCodex: async () => JSON.stringify(result(status, status)) });
    await h.ai_run({ workDir, task: TASK, emit: noop, shared: {} });
    const sum = await h.summarize({ workDir, task: TASK, emit: noop, shared: {} });
    ok(`${status} 映射 ${expectedQueue}`, sum.queueStatus === expectedQueue && sum.status === status);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  {
    const workDir = freshWork();
    const h = make({ runCodex: async () => "not json" });
    await assert.rejects(() => h.ai_run({ workDir, task: TASK, emit: noop, shared: {} }), /結果回報格式錯誤/);
    passed++;
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  {
    const workDir = freshWork();
    const expected = { ...result("success"), changes: ["src/a.js"], commits: [{ hash: "abc1234", message: "fix: a" }] };
    const h = make({ runCodex: async () => JSON.stringify(expected) });
    await h.ai_run({ workDir, task: TASK, emit: noop, shared: {} });
    const sum = await h.summarize({ workDir, task: TASK, emit: noop, shared: {} });
    ok("summarize 回傳修改與 commit 證據", sum.produced[0] === "src/a.js" && sum.commits[0].hash === "abc1234");
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`defaultHandlers.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
