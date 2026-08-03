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
  validateApprovalEvent,
  writeApproval,
} = require("../src/approvalStore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-store-"));
const queueDir = path.join(root, "queue");
const projectPath = path.join(root, "project");
const task = {
  task: "skill-dispatch",
  project_path: projectPath,
  target_branch: "main",
};

try {
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.join(queueDir, "work", "task-1", "workspace"), { recursive: true });

  assert.deepStrictEqual(APPROVAL_STATUSES, ["pending", "processing", "done", "failed", "unknown"]);

  const first = createApproval(
    queueDir,
    "task-1",
    task,
    "  patrick.zyx  ",
    () => new Date("2026-07-21T01:02:03.000Z"),
  );
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.status, "pending");
  assert.deepStrictEqual(first.event, {
    task_id: "task-1",
    project_path: projectPath,
    target_branch: "main",
    approved_by: "patrick.zyx",
    approved_at: "2026-07-21T01:02:03.000Z",
    message: "提交代碼",
    attempt: 0,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(first.event, "workspace_path"));
  assert.ok(fs.existsSync(path.join(queueDir, "approvals", "pending", "task-1.json")));

  const duplicate = createApproval(queueDir, "task-1", task, "jane.doe", () => new Date("2030-01-01T00:00:00.000Z"));
  assert.strictEqual(duplicate.created, false);
  assert.strictEqual(duplicate.event.approved_by, "patrick.zyx");
  assert.strictEqual(duplicate.event.approved_at, "2026-07-21T01:02:03.000Z");

  const processingPath = moveApproval(queueDir, "pending", "processing", "task-1");
  assert.strictEqual(processingPath, path.join(queueDir, "approvals", "processing", "task-1.json"));
  writeApproval(queueDir, "processing", { ...first.event, attempt: 1 });
  assert.strictEqual(findApproval(queueDir, "task-1").status, "processing");

  moveApproval(queueDir, "processing", "done", "task-1");
  assert.strictEqual(findApproval(queueDir, "task-1").status, "done");
  assert.strictEqual(findApproval(queueDir, "missing"), null);

  assert.deepStrictEqual(validateApprovalEvent(queueDir, first.event, "task-1"), first.event);
  const historical = { ...first.event, approved_by: "王小明" };
  delete historical.message;
  assert.strictEqual(
    validateApprovalEvent(queueDir, historical, "task-1").approved_by,
    "王小明",
    "既有 approval event 仍可讀取",
  );
  assert.throws(() => validateApprovalEvent(queueDir, { ...first.event, task_id: "other" }, "task-1"), /task_id/);
  assert.throws(() => validateApprovalEvent(queueDir, { ...first.event, message: "其他訊息" }, "task-1"), /message/);
  assert.throws(() => validateApprovalEvent(queueDir, { ...first.event, approved_at: "not-a-time" }, "task-1"), /approved_at/);
  const withGitIdentity = {
    ...first.event,
    git_identity: {
      previous_local_name_present: false,
      previous_local_name: null,
      applied_name: "patrick.zyx",
      prepared_at: "2026-07-21T01:03:00.000Z",
      applied_at: "2026-07-21T01:03:01.000Z",
      restored_at: "2026-07-21T01:04:00.000Z",
    },
  };
  assert.strictEqual(validateApprovalEvent(queueDir, withGitIdentity, "task-1"), withGitIdentity);
  assert.throws(() => validateApprovalEvent(queueDir, {
    ...withGitIdentity,
    git_identity: { ...withGitIdentity.git_identity, previous_local_name_present: "no" },
  }, "task-1"), /git_identity/);
  assert.throws(() => validateApprovalEvent(queueDir, {
    ...withGitIdentity,
    git_identity: { ...withGitIdentity.git_identity, applied_name: "bad\nname" },
  }, "task-1"), /git_identity/);

  for (const [index, approvedBy] of ["", "   ", "patrick", "patrick.zyx.extra", "patrick.123", "王小明", "a\nb", "x".repeat(101)].entries()) {
    assert.throws(() => createApproval(queueDir, `bad-name-${index}`, task, approvedBy), /公司 ID/);
  }
  assert.throws(() => createApproval(queueDir, "../bad", task, "patrick.zyx"), /task_id/);
  assert.throws(() => createApproval(queueDir, "bad-task", { ...task, task: "other" }, "patrick.zyx"), /skill-dispatch/);
  assert.throws(() => createApproval(queueDir, "no-path", { ...task, project_path: "" }, "patrick.zyx"), /project_path/);
  assert.throws(() => createApproval(queueDir, "missing-path", { ...task, project_path: path.join(root, "missing") }, "patrick.zyx"), /project_path/);
  assert.throws(() => createApproval(queueDir, "no-branch", { ...task, target_branch: "" }, "patrick.zyx"), /target_branch/);
  assert.throws(() => createApproval(queueDir, "bad-branch", { ...task, target_branch: "main\nnext" }, "patrick.zyx"), /target_branch/);
  assert.throws(() => writeApproval(queueDir, "bogus", first.event), /approval status/);

  console.log("approvalStore.test.js: 驗收通知 outbox 儲存層通過 ✅");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
