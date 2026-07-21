"use strict";
const assert = require("assert");
const { approvalExecutor, buildApprovalPrompt } = require("../src/executors/approvalExecutor");

const event = {
  task_id: "task-1",
  project_path: "D:\\GB\\app",
  workspace_path: "D:\\queue\\work\\task-1\\workspace",
  target_branch: "release/task-1",
  approved_by: "王小明",
  approved_at: "2026-07-21T01:02:03.000Z",
  attempt: 0,
};

(async () => {
  const prompt = buildApprovalPrompt(event);
  for (const value of [event.task_id, event.target_branch, event.approved_by, event.approved_at]) {
    assert.ok(prompt.includes(value), `prompt 應包含 ${value}`);
  }
  assert.ok(prompt.includes("Task-ID: task-1"));
  assert.ok(prompt.includes("Approved-by: 王小明"));
  assert.ok(prompt.includes("commit") && prompt.includes("push"));
  assert.ok(prompt.includes("AGENTS.md") && prompt.includes("instructions") && prompt.includes("skills"));
  assert.ok(prompt.includes("不得重複 commit") && prompt.includes("success"));
  for (const forbidden of [".agents/skills", ".claude/skills", ".cursor/skills", ".Codex/skills"]) {
    assert.ok(!prompt.includes(forbidden), `prompt 不得固定 skill 路徑 ${forbidden}`);
  }

  let invocation;
  const result = await approvalExecutor(event, {
    runCodex: async (...args) => {
      invocation = args;
      return JSON.stringify({ status: "success", output: "已發布" });
    },
  });
  assert.strictEqual(invocation[0], prompt);
  assert.strictEqual(invocation[1], event.workspace_path);
  assert.ok(prompt.includes("Task 專屬 Git worktree") && prompt.includes(event.workspace_path));
  assert.ok(prompt.includes("唯一確認變更歸屬") && prompt.includes("共用 project_path"));
  assert.deepStrictEqual(result, { status: "success", output: "已發布" });

  const failed = await approvalExecutor(event, {
    runCodex: async () => JSON.stringify({ status: "failed", output: "push 被拒絕" }),
  });
  assert.deepStrictEqual(failed, { status: "failed", output: "push 被拒絕" });

  await assert.rejects(
    () => approvalExecutor(event, { runCodex: async () => "not json" }),
    /Codex 結果回報格式錯誤/
  );

  console.log("approvalExecutor.test.js: 驗收發布通知通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
