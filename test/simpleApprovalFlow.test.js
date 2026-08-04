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
const { writeTaskSession } = require("./support/codexSessionFixture");

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
const gitVerification = {
  preparePublishVerification: async () => ({
    before_head: "a".repeat(40), remote: "origin", branch: "main",
  }),
  verifyPublishedCommit: async () => ({
    status: "success",
    commit_id: "b".repeat(40),
    commit_subject: "修改：完成簡化驗收",
    committer_name: "patrick.zyx",
    identity_mismatch: false,
  }),
};

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

    writeTaskSession(queueDir, taskId);
    const created = createApproval(
      queueDir,
      taskId,
      task,
      "patrick.zyx",
      () => new Date("2026-07-27T02:00:00.000Z"),
    );
    assert.strictEqual(created.event.message, "提交代碼並推送");

    const accepted = collectTasks(queueDir, {}, 10)[0];
    assert.strictEqual(accepted.approval.status, "pending");
    assert.strictEqual(accepted.verified, false);
    assert.strictEqual(taskDisplayStatus(accepted), "publish_pending", "建立通知事件後必須等待推送結果");

    const prompt = buildApprovalPrompt(created.event);
    assert.ok(prompt.includes("通知內容：提交代碼並推送"));
    assert.ok(prompt.includes(taskId));
    assert.ok(!prompt.includes("不得重複 commit"));
    assert.ok(!prompt.includes("Task-ID:"));
    assert.ok(prompt.includes("push"));

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
      gitVerification,
    });
    assert.strictEqual(status, "done");
    assert.strictEqual(findApproval(queueDir, taskId).event.delivered_at, "2026-07-27T03:00:00.000Z");

    const failureId = "delivery-failure";
    writeTaskSession(queueDir, failureId);
    const failedCreated = createApproval(queueDir, failureId, task, "patrick.zyx");
    const failedStatus = await processApproval(approvalFile("pending", failureId), {
      queueDir,
      logger: silentLogger,
      executor: async () => { throw new Error("Codex 無法啟動"); },
      gitVerification: {
        ...gitVerification,
        verifyPublishedCommit: async () => ({ status: "failed", error: "遠端尚未更新" }),
      },
    });
    assert.strictEqual(failedStatus, "failed");
    assert.strictEqual(findApproval(queueDir, failureId).status, "failed");
    assert.strictEqual(findApproval(queueDir, failureId).event.attempt, 1);
    assert.ok(!fs.existsSync(approvalFile("pending", failureId)), "通知失敗不可自動重送");
    assert.strictEqual(failedCreated.event.message, "提交代碼並推送");

    const recoveryId = "interrupted-delivery";
    writeTaskSession(queueDir, recoveryId);
    createApproval(queueDir, recoveryId, task, "patrick.zyx");
    moveApproval(queueDir, "pending", "processing", recoveryId);
    assert.strictEqual(await recoverApprovals(queueDir, silentLogger, () => new Date(), { gitVerification }), 1);
    assert.strictEqual(findApproval(queueDir, recoveryId).status, "done");
    assert.ok(!fs.existsSync(approvalFile("pending", recoveryId)), "中斷事件不可重新傳送");

    const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "public", "index.html"), "utf8");
    const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "server.js"), "utf8");
    assert.ok(dashboardSource.includes("retry-approval"));
    assert.ok(dashboardSource.includes('publishing: "推送中"'));
    assert.ok(serverSource.includes("retryApproval"));

    console.log("simpleApprovalFlow.test.js: 驗收等待、推送驗證與手動重試流程通過 ✅");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
