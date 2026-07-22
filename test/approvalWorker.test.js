"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApproval, findApproval, moveApproval, writeApproval } = require("../src/approvalStore");
const { pollApprovals, processApproval, recoverApprovals } = require("../src/approvalWorker");

const silentLogger = { log() {}, error() {} };
const task = { task: "skill-dispatch", project_path: "D:\\GB\\app", target_branch: "main" };

function freshQueue() {
  const dir = path.join(os.tmpdir(), `approval-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pending(queueDir, id, approvedBy = "worker.tester") {
  fs.mkdirSync(path.join(queueDir, "work", id, "workspace"), { recursive: true });
  createApproval(queueDir, id, task, approvedBy, () => new Date("2026-07-21T01:00:00.000Z"));
  return path.join(queueDir, "approvals", "pending", `${id}.json`);
}

(async () => {
  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "success");
    let sawProcessing = false;
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      maxAttempts: 3,
      nowFn: () => new Date("2026-07-21T02:00:00.000Z"),
      executor: async (event) => {
        sawProcessing = fs.existsSync(path.join(queueDir, "approvals", "processing", "success.json"));
        assert.strictEqual(event.attempt, 1);
        assert.strictEqual(event.approved_by, "worker.tester");
        return { status: "success", output: "已發布" };
      },
    });
    assert.strictEqual(status, "done");
    assert.strictEqual(sawProcessing, true);
    const saved = findApproval(queueDir, "success");
    assert.strictEqual(saved.status, "done");
    assert.strictEqual(saved.event.completed_at, "2026-07-21T02:00:00.000Z");
    assert.deepStrictEqual(saved.event.result, { status: "success", output: "已發布" });
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "retry");
    const status = await processApproval(file, {
      queueDir, logger: silentLogger, maxAttempts: 3,
      executor: async () => { throw new Error("temporary"); },
    });
    assert.strictEqual(status, "retry");
    const saved = findApproval(queueDir, "retry");
    assert.strictEqual(saved.status, "pending");
    assert.strictEqual(saved.event.attempt, 1);
    assert.strictEqual(saved.event.last_error, "temporary");
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "structured-failure");
    const status = await processApproval(file, {
      queueDir, logger: silentLogger, maxAttempts: 1,
      nowFn: () => new Date("2026-07-21T03:00:00.000Z"),
      executor: async () => ({ status: "failed", output: "push 被拒絕" }),
    });
    assert.strictEqual(status, "failed");
    const saved = findApproval(queueDir, "structured-failure");
    assert.strictEqual(saved.status, "failed");
    assert.strictEqual(saved.event.attempt, 1);
    assert.ok(saved.event.last_error.includes("push 被拒絕"));
    assert.strictEqual(saved.event.failed_at, "2026-07-21T03:00:00.000Z");
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "recover-retry");
    moveApproval(queueDir, "pending", "processing", "recover-retry");
    writeApproval(queueDir, "processing", { ...findApproval(queueDir, "recover-retry").event, attempt: 1 });

    pending(queueDir, "recover-reconcile");
    moveApproval(queueDir, "pending", "processing", "recover-reconcile");
    writeApproval(queueDir, "processing", { ...findApproval(queueDir, "recover-reconcile").event, attempt: 3 });

    pending(queueDir, "recover-success");
    moveApproval(queueDir, "pending", "processing", "recover-success");
    writeApproval(queueDir, "processing", {
      ...findApproval(queueDir, "recover-success").event,
      attempt: 3,
      result: { status: "success", output: "push 完成" },
      completed_at: "2026-07-21T04:00:00.000Z",
    });

    assert.strictEqual(recoverApprovals(queueDir, silentLogger, 3), 3);
    assert.strictEqual(findApproval(queueDir, "recover-retry").status, "pending");
    assert.strictEqual(findApproval(queueDir, "recover-reconcile").status, "pending");
    assert.strictEqual(findApproval(queueDir, "recover-reconcile").event.reconciliation_pending, true);
    assert.strictEqual(findApproval(queueDir, "recover-success").status, "done");

    moveApproval(queueDir, "pending", "processing", "recover-reconcile");
    writeApproval(queueDir, "processing", {
      ...findApproval(queueDir, "recover-reconcile").event,
      attempt: 4,
      reconciliation_pending: false,
      reconciliation_attempted: true,
    });
    assert.strictEqual(recoverApprovals(queueDir, silentLogger, 3), 0);
    assert.strictEqual(findApproval(queueDir, "recover-reconcile").status, "unknown");
    assert.strictEqual(findApproval(queueDir, "recover-reconcile").event.outcome_unknown, true);
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    const pendingDir = path.join(queueDir, "approvals", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, "bad-pending.json"), "{bad", "utf8");
    fs.writeFileSync(path.join(pendingDir, "partial-pending.json"), "{}", "utf8");
    pending(queueDir, "good-after-bad");
    const seen = [];
    const count = await pollApprovals({
      queueDir, logger: silentLogger, maxAttempts: 3,
      executor: async (event) => { seen.push(event.task_id); return { status: "success", output: "ok" }; },
    });
    assert.strictEqual(count, 3);
    assert.deepStrictEqual(seen, ["good-after-bad"]);
    assert.strictEqual(findApproval(queueDir, "bad-pending").status, "failed");
    assert.strictEqual(findApproval(queueDir, "bad-pending").event.malformed, true);
    assert.strictEqual(findApproval(queueDir, "partial-pending").status, "failed");
    assert.strictEqual(findApproval(queueDir, "partial-pending").event.malformed, true);

    const processingDir = path.join(queueDir, "approvals", "processing");
    fs.mkdirSync(processingDir, { recursive: true });
    fs.writeFileSync(path.join(processingDir, "bad-processing.json"), "{bad", "utf8");
    fs.writeFileSync(path.join(processingDir, "partial-processing.json"), JSON.stringify({ task_id: "partial-processing", attempt: 1 }), "utf8");
    pending(queueDir, "recover-after-bad");
    moveApproval(queueDir, "pending", "processing", "recover-after-bad");
    assert.doesNotThrow(() => recoverApprovals(queueDir, silentLogger, 3));
    assert.strictEqual(findApproval(queueDir, "bad-processing").status, "failed");
    assert.strictEqual(findApproval(queueDir, "partial-processing").status, "failed");
    assert.strictEqual(findApproval(queueDir, "recover-after-bad").status, "pending");
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "b");
    pending(queueDir, "a");
    const seen = [];
    const count = await pollApprovals({
      queueDir, logger: silentLogger, maxAttempts: 3,
      executor: async (event) => { seen.push(event.task_id); return { status: "success", output: "ok" }; },
    });
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(seen, ["a", "b"]);
    assert.strictEqual(findApproval(queueDir, "a").status, "done");
    assert.strictEqual(findApproval(queueDir, "b").status, "done");
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  const repo = path.resolve(__dirname, "..");
  const workerSource = fs.readFileSync(path.join(repo, "src", "worker.js"), "utf8");
  assert.ok(workerSource.includes("recoverApprovals") && workerSource.includes("pollApprovals"), "正式 worker 必須消費 approval outbox");
  const configSource = fs.readFileSync(path.join(repo, "src", "config.js"), "utf8");
  assert.ok(configSource.includes("MAX_APPROVAL_ATTEMPTS") && configSource.includes("maxApprovalAttempts"), "設定必須提供 approval 重試上限");
  assert.ok(fs.readFileSync(path.join(repo, ".env.example"), "utf8").includes("MAX_APPROVAL_ATTEMPTS"), "env 範例必須記錄 approval 重試設定");

  console.log("approvalWorker.test.js: 背景發布、重試與復原通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
