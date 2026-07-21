"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  APPROVAL_STATUSES,
  createApproval,
  findApproval,
  moveApproval,
  writeApproval,
} = require("../src/approvalStore");

const root = path.join(os.tmpdir(), `approval-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const queueDir = path.join(root, "queue");
const task = {
  task: "skill-dispatch",
  project_path: "D:\\GB\\app",
  target_branch: "main",
};

try {
  assert.deepStrictEqual(APPROVAL_STATUSES, ["pending", "processing", "done", "failed"]);

  const first = createApproval(queueDir, "task-1", task, " 王小明 ", () => new Date("2026-07-21T01:02:03.000Z"));
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.status, "pending");
  assert.deepStrictEqual(first.event, {
    task_id: "task-1",
    project_path: "D:\\GB\\app",
    target_branch: "main",
    approved_by: "王小明",
    approved_at: "2026-07-21T01:02:03.000Z",
    attempt: 0,
  });
  assert.ok(fs.existsSync(path.join(queueDir, "approvals", "pending", "task-1.json")));

  const duplicate = createApproval(queueDir, "task-1", task, "另一人", () => new Date("2030-01-01T00:00:00.000Z"));
  assert.strictEqual(duplicate.created, false);
  assert.strictEqual(duplicate.event.approved_by, "王小明");
  assert.strictEqual(duplicate.event.approved_at, "2026-07-21T01:02:03.000Z");

  const processingPath = moveApproval(queueDir, "pending", "processing", "task-1");
  assert.strictEqual(processingPath, path.join(queueDir, "approvals", "processing", "task-1.json"));
  writeApproval(queueDir, "processing", { ...first.event, attempt: 1 });
  assert.strictEqual(findApproval(queueDir, "task-1").status, "processing");
  assert.strictEqual(findApproval(queueDir, "task-1").event.attempt, 1);

  moveApproval(queueDir, "processing", "done", "task-1");
  assert.strictEqual(findApproval(queueDir, "task-1").status, "done");
  assert.strictEqual(findApproval(queueDir, "missing"), null);

  for (const approvedBy of ["", "   ", "a\nb", "x".repeat(101)]) {
    assert.throws(() => createApproval(queueDir, `bad-name-${approvedBy.length}`, task, approvedBy), /驗收人/);
  }
  assert.throws(() => createApproval(queueDir, "../bad", task, "王小明"), /task_id/);
  assert.throws(() => createApproval(queueDir, "bad-task", { ...task, task: "other" }, "王小明"), /skill-dispatch/);
  assert.throws(() => createApproval(queueDir, "no-path", { ...task, project_path: "" }, "王小明"), /project_path/);
  assert.throws(() => createApproval(queueDir, "no-branch", { ...task, target_branch: "" }, "王小明"), /target_branch/);
  assert.throws(() => createApproval(queueDir, "bad-branch", { ...task, target_branch: "main\nnext" }, "王小明"), /target_branch/);
  assert.throws(() => writeApproval(queueDir, "unknown", first.event), /approval status/);

  console.log("approvalStore.test.js: approval outbox 儲存層通過 ✅");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
