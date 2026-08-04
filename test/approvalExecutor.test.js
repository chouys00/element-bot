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
  message: "提交代碼並推送",
  codex_session_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  attempt: 0,
};

(async () => {
  const prompt = buildApprovalPrompt(event);
  for (const value of [event.task_id, event.target_branch, event.approved_by, event.approved_at]) {
    assert.ok(prompt.includes(value), `prompt 應包含 ${value}`);
  }
  assert.ok(prompt.includes("通知內容：提交代碼並推送"));
  assert.ok(prompt.includes('git config --local user.name "王小明"'));
  assert.ok(prompt.includes("commit message") && prompt.includes("提交代碼並推送"));
  assert.ok(prompt.includes("push"));
  assert.ok(prompt.includes("Codex 結束後") && prompt.includes("還原"));
  assert.ok(prompt.includes("AGENTS.md") && prompt.includes("instructions") && prompt.includes("skills"));
  assert.ok(prompt.includes("唯讀") && prompt.includes("驗證遠端分支"));
  assert.ok(!prompt.includes("不等待或判定後續處理結果"));
  for (const forbidden of ["Task-ID:", "Approved-by:", "worktree"]) {
    assert.ok(!prompt.includes(forbidden), `prompt 不應控制專案後續處理：${forbidden}`);
  }

  const retryPrompt = buildApprovalPrompt({ ...event, attempt: 2 });
  assert.ok(retryPrompt.includes("人工觸發的重試"));
  assert.ok(retryPrompt.includes("沿用") && retryPrompt.includes("不得建立內容相同的重複 commit"));

  let invocation;
  const result = await approvalExecutor(event, {
    runCodex: async (...args) => {
      invocation = args;
      return {
        output: JSON.stringify({ status: "blocked", output: "專案自行決定後續處理" }),
        sessionId: event.codex_session_id,
      };
    },
  });
  assert.strictEqual(invocation[0], prompt);
  assert.strictEqual(invocation[1], event.project_path);
  assert.deepStrictEqual(invocation[2], { resumeSessionId: event.codex_session_id });
  assert.deepStrictEqual(result, {
    delivered: true,
    output: JSON.stringify({ status: "blocked", output: "專案自行決定後續處理" }),
  });

  const unstructured = await approvalExecutor(event, {
    runCodex: async () => "專案已收到通知",
  });
  assert.deepStrictEqual(unstructured, { delivered: true, output: "專案已收到通知" });

  await assert.rejects(
    () => approvalExecutor({ ...event, codex_session_id: undefined }, {
      runCodex: async () => { throw new Error("不應啟動新對話"); },
    }),
    /Codex session|重新執行/,
  );

  console.log("approvalExecutor.test.js: 驗收後單向通知通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
