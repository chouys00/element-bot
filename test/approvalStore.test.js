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
  retryApproval,
  validateApprovalEvent,
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
  assert.deepStrictEqual(APPROVAL_STATUSES, ["pending", "processing", "done", "failed", "unknown"]);

  const workspacePath = path.join(queueDir, "work", "task-1", "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });

  const first = createApproval(queueDir, "task-1", task, " 王小明 ", () => new Date("2026-07-21T01:02:03.000Z"));
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.status, "pending");
  assert.deepStrictEqual(first.event, {
    task_id: "task-1",
    project_path: "D:\\GB\\app",
    workspace_path: workspacePath,
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

  fs.mkdirSync(path.join(queueDir, "work", "retry-1", "workspace"), { recursive: true });
  const retryCreated = createApproval(queueDir, "retry-1", task, "陳小華");
  moveApproval(queueDir, "pending", "failed", "retry-1");
  writeApproval(queueDir, "failed", { ...retryCreated.event, attempt: 3, last_error: "push failed", failed_at: "2026-07-21T03:00:00.000Z" });
  const retried = retryApproval(queueDir, "retry-1");
  assert.strictEqual(retried.status, "pending");
  assert.strictEqual(retried.event.approved_by, "陳小華");
  assert.strictEqual(retried.event.attempt, 0);
  assert.strictEqual(retried.event.retry_count, 1);
  assert.strictEqual(retried.event.last_error, undefined);

  assert.deepStrictEqual(validateApprovalEvent(queueDir, retried.event, "retry-1"), retried.event);
  assert.throws(() => validateApprovalEvent(queueDir, { ...retried.event, task_id: "other" }, "retry-1"), /task_id/);
  assert.throws(() => validateApprovalEvent(queueDir, { ...retried.event, workspace_path: queueDir }, "retry-1"), /workspace_path/);
  assert.throws(() => validateApprovalEvent(queueDir, { ...retried.event, approved_at: "not-a-time" }, "retry-1"), /approved_at/);

  fs.mkdirSync(path.join(queueDir, "approvals", "failed"), { recursive: true });
  writeApproval(queueDir, "failed", { task_id: "malformed-retry", malformed: true, last_error: "bad", attempt: 0 });
  assert.throws(() => retryApproval(queueDir, "malformed-retry"), /損毀/);

  for (const approvedBy of ["", "   ", "a\nb", "x".repeat(101)]) {
    assert.throws(() => createApproval(queueDir, `bad-name-${approvedBy.length}`, task, approvedBy), /驗收人/);
  }
  assert.throws(() => createApproval(queueDir, "../bad", task, "王小明"), /task_id/);
  assert.throws(() => createApproval(queueDir, "bad-task", { ...task, task: "other" }, "王小明"), /skill-dispatch/);
  assert.throws(() => createApproval(queueDir, "no-path", { ...task, project_path: "" }, "王小明"), /project_path/);
  assert.throws(() => createApproval(queueDir, "no-branch", { ...task, target_branch: "" }, "王小明"), /target_branch/);
  assert.throws(() => createApproval(queueDir, "bad-branch", { ...task, target_branch: "main\nnext" }, "王小明"), /target_branch/);
  assert.throws(() => createApproval(queueDir, "no-workspace", task, "王小明"), /專屬工作區/);
  assert.throws(() => writeApproval(queueDir, "bogus", first.event), /approval status/);

  console.log("approvalStore.test.js: approval outbox 儲存層通過 ✅");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
