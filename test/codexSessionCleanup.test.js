"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  CLEANUP_INTERVAL_MS,
  RETENTION_MS,
  cleanupExpiredCodexSessions,
  createCodexSessionCleanupScheduler,
} = require("../src/codexSessionCleanup");
const { readCodexSession, writeCodexSession } = require("../src/codexSessionStore");
const { createClosure } = require("../src/taskClosureStore");
const { acquireSessionLifecycleLock } = require("../src/sessionLifecycleLock");
const { writeTaskSession } = require("./support/codexSessionFixture");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-cleanup-"));
const queueDir = path.join(root, "queue");
const nowIso = "2026-08-12T00:00:00.000Z";
const nowMs = Date.parse(nowIso);

function sessionId(suffix) {
  return `0199a213-81c0-7800-8aa1-bbab2a035a${suffix}`;
}

function writeApproval(taskId, status, publish, codexSessionId) {
  const dir = path.join(queueDir, "approvals", status);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify({
    task_id: taskId,
    project_path: path.join(root, "project"),
    target_branch: "main",
    approved_by: "patrick.zyx",
    approved_at: "2026-08-01T00:00:00.000Z",
    message: "提交代碼並推送",
    codex_session_id: codexSessionId,
    attempt: 1,
    publish,
  }), "utf8");
}

(async () => {
try {
  const expiredId = sessionId("53");
  writeTaskSession(queueDir, "expired-success", expiredId);
  const expiredReplacementId = sessionId("5d");
  writeCodexSession(path.join(queueDir, "work", "expired-success"), {
    task_id: "expired-success",
    session_id: expiredReplacementId,
    created_at: "2026-08-03T00:00:00.000Z",
  });
  writeApproval("expired-success", "done", {
    status: "success",
    finished_at: "2026-08-04T00:00:00.000Z",
  }, expiredReplacementId);

  const recentId = sessionId("54");
  writeTaskSession(queueDir, "recent-success", recentId);
  writeApproval("recent-success", "done", {
    status: "success",
    finished_at: "2026-08-06T00:00:01.000Z",
  }, recentId);

  const failedId = sessionId("55");
  writeTaskSession(queueDir, "publish-failed", failedId);
  writeApproval("publish-failed", "failed", {
    status: "failed",
    finished_at: "2026-08-01T00:00:00.000Z",
    error: "遠端尚未更新",
  }, failedId);

  const unknownId = sessionId("56");
  writeTaskSession(queueDir, "publish-unknown", unknownId);
  writeApproval("publish-unknown", "unknown", {
    status: "unknown",
    finished_at: "2026-08-01T00:00:00.000Z",
    error: "遠端逾時",
  }, unknownId);

  const closedId = sessionId("57");
  writeTaskSession(queueDir, "closed-expired", closedId);
  createClosure(queueDir, "closed-expired", "patrick.zyx", () => new Date("2026-08-04T00:00:00.000Z"));

  const mismatchId = sessionId("58");
  writeTaskSession(queueDir, "session-mismatch", mismatchId);
  writeApproval("session-mismatch", "done", {
    status: "success",
    finished_at: "2026-08-01T00:00:00.000Z",
  }, sessionId("59"));

  const deletedId = sessionId("5a");
  writeCodexSession(path.join(queueDir, "work", "already-deleted"), {
    task_id: "already-deleted",
    session_id: deletedId,
    created_at: "2026-07-21T00:00:00.000Z",
    deleted_at: "2026-08-10T00:00:00.000Z",
  });
  writeApproval("already-deleted", "done", {
    status: "success",
    finished_at: "2026-08-01T00:00:00.000Z",
  }, deletedId);

  const deleteFailureOldId = sessionId("5b");
  writeTaskSession(queueDir, "delete-failure", deleteFailureOldId);
  const deleteFailureId = sessionId("5e");
  writeCodexSession(path.join(queueDir, "work", "delete-failure"), {
    task_id: "delete-failure",
    session_id: deleteFailureId,
    created_at: "2026-08-02T00:00:00.000Z",
  });
  writeApproval("delete-failure", "done", {
    status: "success",
    finished_at: "2026-08-01T00:00:00.000Z",
  }, deleteFailureId);

  const partialDeleteId = sessionId("5c");
  writeTaskSession(queueDir, "partial-delete", partialDeleteId);
  writeApproval("partial-delete", "done", {
    status: "success",
    finished_at: "2026-08-01T00:00:00.000Z",
  }, partialDeleteId);

  const deleted = [];
  const result = await cleanupExpiredCodexSessions({
    queueDir,
    now: () => new Date(nowIso),
    deleteSession: async (id) => {
      if (id === deleteFailureId) throw new Error("session 被占用\n稍後重試");
      if (id === deleteFailureOldId) {
        deleted.push(id);
        return {
          deleted: true,
          metadataDeleted: false,
          warning: "舊 session rollout 已刪除但索引殘留",
        };
      }
      if (id === partialDeleteId) {
        deleted.push(id);
        return {
          deleted: true,
          metadataDeleted: false,
          warning: "Codex 索引未清除: no such table: agent_jobs",
        };
      }
      deleted.push(id);
      return { deleted: true, metadataDeleted: true };
    },
    logger: { log() {}, error() {} },
  });

  assert.deepStrictEqual(
    deleted.sort(),
    [closedId, expiredId, expiredReplacementId, partialDeleteId, deleteFailureOldId].sort(),
    "滿七天時連同重新執行留下的舊 session 一起精確刪除",
  );
  assert.deepStrictEqual(result, { scanned: 9, deleted: 3, skipped: 5, failed: 1, warnings: 1 });
  assert.strictEqual(readCodexSession(path.join(queueDir, "work", "expired-success"), "expired-success").deleted_at, nowIso);
  assert.deepStrictEqual(
    readCodexSession(path.join(queueDir, "work", "expired-success"), "expired-success").deleted_session_ids.sort(),
    [expiredId, expiredReplacementId].sort(),
  );
  assert.strictEqual(readCodexSession(path.join(queueDir, "work", "closed-expired"), "closed-expired").deleted_at, nowIso);
  const partialDelete = readCodexSession(path.join(queueDir, "work", "partial-delete"), "partial-delete");
  assert.strictEqual(partialDelete.deleted_at, nowIso);
  assert.match(partialDelete.delete_warning, /agent_jobs/);
  assert.strictEqual(readCodexSession(path.join(queueDir, "work", "recent-success"), "recent-success").deleted_at, undefined);
  assert.strictEqual(readCodexSession(path.join(queueDir, "work", "publish-failed"), "publish-failed").deleted_at, undefined);
  assert.strictEqual(readCodexSession(path.join(queueDir, "work", "publish-unknown"), "publish-unknown").deleted_at, undefined);
  const failedDelete = readCodexSession(path.join(queueDir, "work", "delete-failure"), "delete-failure");
  assert.strictEqual(failedDelete.delete_attempted_at, nowIso);
  assert.match(failedDelete.delete_error, /session 被占用.*稍後重試/);
  assert.ok(!failedDelete.delete_error.includes("\n"));
  assert.match(failedDelete.delete_warning, /舊 session rollout/);
  assert.deepStrictEqual(failedDelete.deleted_session_ids, [deleteFailureOldId]);

  assert.strictEqual(RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.strictEqual(CLEANUP_INTERVAL_MS, 24 * 60 * 60 * 1000);
  let schedulerNow = nowMs;
  let cleanupCalls = 0;
  const scheduler = createCodexSessionCleanupScheduler({
    queueDir,
    nowMs: () => schedulerNow,
    cleanup: async () => { cleanupCalls++; return { deleted: 0 }; },
  });
  assert.deepStrictEqual(await scheduler.poll(), { deleted: 0 });
  assert.strictEqual(cleanupCalls, 1, "worker 啟動第一次輪詢會清理");
  schedulerNow += CLEANUP_INTERVAL_MS - 1;
  assert.strictEqual(await scheduler.poll(), null);
  assert.strictEqual(cleanupCalls, 1, "24 小時內不重複清理");
  const restartedScheduler = createCodexSessionCleanupScheduler({
    queueDir,
    nowMs: () => schedulerNow,
    cleanup: async () => { cleanupCalls++; return { deleted: 0 }; },
  });
  assert.strictEqual(await restartedScheduler.poll(), null);
  assert.strictEqual(cleanupCalls, 1, "worker 重啟後仍沿用持久化的 24 小時水位");
  schedulerNow += 1;
  assert.deepStrictEqual(await restartedScheduler.poll(), { deleted: 0 });
  assert.strictEqual(cleanupCalls, 2, "滿 24 小時才再次清理");

  createClosure(queueDir, "locked-reopen", "patrick.zyx", () => new Date("2026-08-01T00:00:00.000Z"));
  const release = acquireSessionLifecycleLock(queueDir, "locked-reopen");
  assert.throws(
    () => require("../src/taskClosureStore").reopenClosure(queueDir, "locked-reopen"),
    (error) => error && error.code === "SESSION_CLEANUP_BUSY",
    "清理鎖持有期間不得同時重新開啟任務",
  );
  release();
  assert.strictEqual(require("../src/taskClosureStore").reopenClosure(queueDir, "locked-reopen"), true);

  const deletedReopenId = sessionId("5f");
  writeCodexSession(path.join(queueDir, "work", "deleted-reopen"), {
    task_id: "deleted-reopen",
    session_id: deletedReopenId,
    created_at: "2026-07-01T00:00:00.000Z",
    deleted_session_ids: [deletedReopenId],
    deleted_at: "2026-08-10T00:00:00.000Z",
  });
  createClosure(queueDir, "deleted-reopen", "patrick.zyx", () => new Date("2026-08-01T00:00:00.000Z"));
  assert.throws(
    () => require("../src/taskClosureStore").reopenClosure(queueDir, "deleted-reopen"),
    (error) => error && error.code === "CODEX_SESSION_DELETED",
    "session 已永久刪除後不得重新開啟",
  );

  console.log("codexSessionCleanup.test.js: 七日保存、安全刪除與每日排程通過 ✅");
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
})().catch((error) => { console.error(error); process.exit(1); });
