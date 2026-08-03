"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { collectTasks, taskDisplayStatus } = require("../src/dashboard/aggregate");
const { createApproval, findApproval, moveApproval } = require("../src/approvalStore");
const { approvalExecutor, buildApprovalPrompt } = require("../src/executors/approvalExecutor");
const { processApproval, recoverApprovals } = require("../src/approvalWorker");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-simple-approval-"));
const queueDir = path.join(root, "queue");
const projectPath = path.join(root, "project");
const taskId = "simple-approval";
const task = {
  task: "skill-dispatch",
  project_path: projectPath,
  target_branch: "main",
  enqueued_at: "2026-07-27T01:00:00.000Z",
  source: {},
};
const silentLogger = { log() {}, error() {} };

function git(args) {
  const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(" ")} 失敗`);
}

function approvalFile(status, id) {
  return path.join(queueDir, "approvals", status, `${id}.json`);
}

(async () => {
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    git(["init", "-q"]);
    git(["config", "--local", "user.name", "simple baseline"]);
    git(["config", "--local", "user.email", "simple@example.invalid"]);
    fs.mkdirSync(path.join(queueDir, "done"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "done", `${taskId}.json`), JSON.stringify(task), "utf8");

    const before = collectTasks(queueDir, {}, 10)[0];
    assert.strictEqual(taskDisplayStatus(before), "review");

    const created = createApproval(
      queueDir,
      taskId,
      task,
      "patrick.zyx",
      () => new Date("2026-07-27T02:00:00.000Z"),
    );
    assert.strictEqual(created.event.message, "提交代碼");

    const accepted = collectTasks(queueDir, {}, 10)[0];
    assert.strictEqual(accepted.approval.status, "pending");
    assert.strictEqual(accepted.verified, true);
    assert.strictEqual(taskDisplayStatus(accepted), "done", "建立通知事件後任務必須立即完成");

    const prompt = buildApprovalPrompt(created.event);
    assert.ok(prompt.includes("通知內容：提交代碼"));
    assert.ok(prompt.includes(taskId));
    assert.ok(!prompt.includes("不得重複 commit"));
    assert.ok(!prompt.includes("Task-ID:"));
    assert.ok(!prompt.includes("push"));

    let invocation;
    const delivered = await approvalExecutor(created.event, {
      runCodex: async (...args) => {
        invocation = args;
        return "專案已收到通知";
      },
    });
    assert.strictEqual(invocation[1], projectPath);
    assert.deepStrictEqual(delivered, { delivered: true, output: "專案已收到通知" });

    const status = await processApproval(approvalFile("pending", taskId), {
      queueDir,
      logger: silentLogger,
      nowFn: () => new Date("2026-07-27T03:00:00.000Z"),
      executor: async () => ({ delivered: true, output: "收到" }),
    });
    assert.strictEqual(status, "done");
    assert.strictEqual(findApproval(queueDir, taskId).event.delivered_at, "2026-07-27T03:00:00.000Z");

    const failureId = "delivery-failure";
    const failedCreated = createApproval(queueDir, failureId, task, "patrick.zyx");
    const failedStatus = await processApproval(approvalFile("pending", failureId), {
      queueDir,
      logger: silentLogger,
      executor: async () => { throw new Error("Codex 無法啟動"); },
    });
    assert.strictEqual(failedStatus, "failed");
    assert.strictEqual(findApproval(queueDir, failureId).status, "failed");
    assert.strictEqual(findApproval(queueDir, failureId).event.attempt, 1);
    assert.ok(!fs.existsSync(approvalFile("pending", failureId)), "通知失敗不可自動重送");
    assert.strictEqual(failedCreated.event.message, "提交代碼");

    const recoveryId = "interrupted-delivery";
    createApproval(queueDir, recoveryId, task, "patrick.zyx");
    moveApproval(queueDir, "pending", "processing", recoveryId);
    assert.strictEqual(await recoverApprovals(queueDir, silentLogger), 1);
    assert.strictEqual(findApproval(queueDir, recoveryId).status, "done");
    assert.ok(!fs.existsSync(approvalFile("pending", recoveryId)), "中斷事件不可重新傳送");

    const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "public", "index.html"), "utf8");
    const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "server.js"), "utf8");
    assert.ok(!dashboardSource.includes("publish-retry"));
    assert.ok(!dashboardSource.includes('publishing: "提交中"'));
    assert.ok(!serverSource.includes("retryApproval"));

    console.log("simpleApprovalFlow.test.js: 簡化驗收與單向通知流程通過 ✅");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
