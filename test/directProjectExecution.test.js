"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getTaskDef } = require("../src/taskDefs");
const { make } = require("../src/executors/defaultHandlers");
const { createApproval } = require("../src/approvalStore");
const { approvalExecutor, buildApprovalPrompt } = require("../src/executors/approvalExecutor");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-direct-project-"));
const queueDir = path.join(root, "queue");
const projectPath = path.join(root, "project");
fs.mkdirSync(projectPath, { recursive: true });

const task = {
  task: "skill-dispatch",
  project_path: projectPath,
  target_branch: "main",
  command: "修改優惠辦理的域名",
};

(async () => {
  try {
    const prompt = getTaskDef("skill-dispatch").prompt(task, {
      id: "task-direct",
      workDir: path.join(queueDir, "work", "task-direct"),
    });
    assert.ok(prompt.includes(projectPath));
    assert.ok(prompt.includes("直接在 project_path"));
    assert.ok(prompt.includes("Dashboard 驗收") && prompt.includes("不得執行 commit") && prompt.includes("不得執行 push"));
    assert.ok(!prompt.includes("git worktree add"));
    assert.ok(!prompt.includes("Task 專屬工作區"));

    let initialInvocation;
    const handlers = make({
      runCodex: async (...args) => {
        initialInvocation = args;
        return {
          output: JSON.stringify({ status: "success", output: "已修改，等待驗收" }),
          sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
        };
      },
    });
    const workDir = path.join(queueDir, "work", "task-direct");
    await handlers.ai_run({
      id: "task-direct",
      workDir,
      task,
      emit() {},
      shared: {},
    });
    assert.strictEqual(initialInvocation[1], path.resolve(projectPath));

    const approval = createApproval(
      queueDir,
      "task-direct",
      task,
      "patrick.zyx",
      () => new Date("2026-07-27T01:02:03.000Z"),
    );
    assert.strictEqual(approval.created, true);
    assert.strictEqual(approval.event.project_path, projectPath);
    assert.ok(!Object.prototype.hasOwnProperty.call(approval.event, "workspace_path"));

    const approvalPrompt = buildApprovalPrompt(approval.event);
    assert.ok(approvalPrompt.includes("通知內容：提交代碼並推送"));
    assert.ok(approvalPrompt.includes("push"));
    assert.ok(approvalPrompt.includes("target_branch: main"));
    assert.ok(approvalPrompt.includes(`project_path: ${projectPath}`));
    assert.ok(!approvalPrompt.includes("worktree"));

    let publishInvocation;
    const published = await approvalExecutor(approval.event, {
      runCodex: async (...args) => {
        publishInvocation = args;
        return JSON.stringify({ status: "blocked", output: "專案已收到，後續自行處理" });
      },
    });
    assert.deepStrictEqual(published, {
      delivered: true,
      output: JSON.stringify({ status: "blocked", output: "專案已收到，後續自行處理" }),
    });
    assert.strictEqual(publishInvocation[1], projectPath);
    assert.deepStrictEqual(publishInvocation[2], { resumeSessionId: approval.event.codex_session_id });

    console.log("directProjectExecution.test.js: 初次修改與驗收通知均直接使用 project_path ✅");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
