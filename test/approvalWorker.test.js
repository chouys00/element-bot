"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApproval, findApproval, moveApproval } = require("../src/approvalStore");
const { pollApprovals, processApproval, recoverApprovals } = require("../src/approvalWorker");

const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-worker-"));
  fs.mkdirSync(path.join(queueDir, "project"), { recursive: true });
  return queueDir;
}

function taskFor(queueDir) {
  return {
    task: "skill-dispatch",
    project_path: path.join(queueDir, "project"),
    target_branch: "main",
  };
}

function pending(queueDir, id, approvedBy = "worker.tester") {
  createApproval(
    queueDir,
    id,
    taskFor(queueDir),
    approvedBy,
    () => new Date("2026-07-21T01:00:00.000Z"),
  );
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
      nowFn: () => new Date("2026-07-21T02:00:00.000Z"),
      executor: async (event) => {
        sawProcessing = fs.existsSync(path.join(queueDir, "approvals", "processing", "success.json"));
        assert.strictEqual(event.attempt, 1);
        return { delivered: true, output: "已收到" };
      },
    });
    assert.strictEqual(status, "done");
    assert.strictEqual(sawProcessing, true);
    const saved = findApproval(queueDir, "success");
    assert.strictEqual(saved.status, "done");
    assert.strictEqual(saved.event.delivered_at, "2026-07-21T02:00:00.000Z");
    assert.deepStrictEqual(saved.event.result, { delivered: true, output: "已收到" });
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "failure");
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      nowFn: () => new Date("2026-07-21T03:00:00.000Z"),
      executor: async () => { throw new Error("Codex 無法啟動"); },
    });
    assert.strictEqual(status, "failed");
    const saved = findApproval(queueDir, "failure");
    assert.strictEqual(saved.status, "failed");
    assert.strictEqual(saved.event.attempt, 1);
    assert.strictEqual(saved.event.last_error, "Codex 無法啟動");
    assert.strictEqual(saved.event.failed_at, "2026-07-21T03:00:00.000Z");
    assert.ok(!fs.existsSync(path.join(queueDir, "approvals", "pending", "failure.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "interrupted");
    moveApproval(queueDir, "pending", "processing", "interrupted");
    const recovered = recoverApprovals(
      queueDir,
      silentLogger,
      () => new Date("2026-07-21T04:00:00.000Z"),
    );
    assert.strictEqual(recovered, 1);
    const saved = findApproval(queueDir, "interrupted");
    assert.strictEqual(saved.status, "done");
    assert.strictEqual(saved.event.delivery_uncertain_at, "2026-07-21T04:00:00.000Z");
    assert.ok(!fs.existsSync(path.join(queueDir, "approvals", "pending", "interrupted.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
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
      queueDir,
      logger: silentLogger,
      executor: async (event) => {
        seen.push(event.task_id);
        return { delivered: true, output: "ok" };
      },
    });
    assert.strictEqual(count, 3);
    assert.deepStrictEqual(seen, ["good-after-bad"]);
    assert.strictEqual(findApproval(queueDir, "bad-pending").status, "failed");
    assert.strictEqual(findApproval(queueDir, "partial-pending").status, "failed");

    const processingDir = path.join(queueDir, "approvals", "processing");
    fs.mkdirSync(processingDir, { recursive: true });
    fs.writeFileSync(path.join(processingDir, "bad-processing.json"), "{bad", "utf8");
    assert.doesNotThrow(() => recoverApprovals(queueDir, silentLogger));
    assert.strictEqual(findApproval(queueDir, "bad-processing").status, "failed");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "b");
    pending(queueDir, "a");
    const seen = [];
    const count = await pollApprovals({
      queueDir,
      logger: silentLogger,
      executor: async (event) => {
        seen.push(event.task_id);
        return { delivered: true, output: "ok" };
      },
    });
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(seen, ["a", "b"]);
    assert.strictEqual(findApproval(queueDir, "a").status, "done");
    assert.strictEqual(findApproval(queueDir, "b").status, "done");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  const repo = path.resolve(__dirname, "..");
  const workerSource = fs.readFileSync(path.join(repo, "src", "worker.js"), "utf8");
  const configSource = fs.readFileSync(path.join(repo, "src", "config.js"), "utf8");
  assert.ok(workerSource.includes("recoverApprovals") && workerSource.includes("pollApprovals"));
  assert.ok(!workerSource.includes("maxApprovalAttempts"));
  assert.ok(!configSource.includes("MAX_APPROVAL_ATTEMPTS"));
  assert.ok(!fs.readFileSync(path.join(repo, ".env.example"), "utf8").includes("MAX_APPROVAL_ATTEMPTS"));

  console.log("approvalWorker.test.js: 單次通知與中斷防重送通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
