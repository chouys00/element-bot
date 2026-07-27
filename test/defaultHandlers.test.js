"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const defaultHandlers = require("../src/executors/defaultHandlers");
const { make } = defaultHandlers;
const opsModule = require("../src/executors/ops");

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; }
const noop = () => {};
const TASK = {
  task: "skill-dispatch",
  project_path: "D:\\GB\\sample-app",
  target_branch: "main",
  command: "分析專案",
};

function freshWork() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dh-"));
}

(async () => {
  assert.deepStrictEqual(Object.keys(defaultHandlers), ["make"], "handler 不暴露未使用的內部檔名");
  passed++;
  assert.deepStrictEqual(Object.keys(opsModule), ["runCodex"], "ops 只保留 Codex execute 邊界");
  passed++;

  {
    const workDir = freshWork();
    const emitted = [];
    const handlers = make({ runCodex: async () => { throw new Error("不應在 prepare 執行 Codex"); } });
    await handlers.prepare({ workDir, task: TASK, emit: (entry) => emitted.push(entry), shared: {} });
    ok("prepare 不建立舊版 base.json", !fs.existsSync(path.join(workDir, "base.json")));
    ok("prepare 保留目標專案確認步驟", emitted.some((entry) => entry.step === "prepare"));
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  {
    const workDir = freshWork();
    const emitted = [];
    const expected = { status: "success", output: "先前已完成，無需重複操作；證據：記錄 123。" };
    let invocation;
    const handlers = make({
      runCodex: async (...args) => {
        invocation = args;
        return JSON.stringify(expected);
      },
    });
    await handlers.ai_run({
      id: "task-1",
      workDir,
      task: TASK,
      emit: (entry) => emitted.push(entry),
      shared: {},
    });
    const summary = await handlers.summarize({ workDir, task: TASK, shared: {} });
    ok("executor 不再傳遞結果模式", invocation.length === 2);
    ok("提示詞維持 generic 無人值守契約", invocation[0].includes("無人值守") && invocation[0].includes("完整 output"));
    ok("Codex 直接在 project_path 執行", invocation[1] === path.resolve(TASK.project_path));
    ok("提示詞不要求建立 worktree", !invocation[0].includes("git worktree") && !invocation[0].includes("Task 專屬工作區"));
    ok("結果原樣持久化", JSON.parse(fs.readFileSync(path.join(workDir, "task-result.json"), "utf8")).output === expected.output);
    ok("完整輸出交給 dashboard", emitted.some((entry) => entry.ai_output === expected.output));
    ok("沒有改動仍為 done", summary.status === "success" && summary.queueStatus === "done");
    ok("不捏造 produced", Array.isArray(summary.produced) && summary.produced.length === 0);
    ok("summary 不提供開啟專案路徑", !Object.prototype.hasOwnProperty.call(summary, "openPath"));
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  for (const [status, expectedQueue] of [["failed", "failed"], ["blocked", "blocked"], ["partial", "review"]]) {
    const workDir = freshWork();
    const handlers = make({ runCodex: async () => JSON.stringify({ status, output: status }) });
    await handlers.ai_run({ id: `task-${status}`, workDir, task: TASK, emit: noop, shared: {} });
    const summary = await handlers.summarize({ workDir, task: TASK, shared: {} });
    ok(`${status} 映射 ${expectedQueue}`, summary.queueStatus === expectedQueue && summary.status === status);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  {
    const workDir = freshWork();
    const handlers = make({ runCodex: async () => "not json" });
    await assert.rejects(
      () => handlers.ai_run({ id: "task-invalid", workDir, task: TASK, emit: noop, shared: {} }),
      /結果回報格式錯誤/,
    );
    passed++;
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`defaultHandlers.test.js: ${passed} 項通過 ✅`);
})().catch((error) => { console.error(error); process.exit(1); });
