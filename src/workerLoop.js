"use strict";

async function pollWorkerLoop(taskDeps, approvalDeps, ops) {
  const approvals = await ops.pollApprovals(approvalDeps);
  if (ops.cleanupSessions) {
    try { await ops.cleanupSessions(); }
    catch (error) { if (ops.onCleanupError) ops.onCleanupError(error); }
  }
  const tasks = await ops.pollOnce(taskDeps);
  return { approvals, tasks };
}

module.exports = { pollWorkerLoop };
