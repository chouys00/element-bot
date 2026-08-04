"use strict";
const fs = require("fs");
const path = require("path");
const { findApproval } = require("./approvalStore");
const { deleteCodexSession } = require("./codexRunner");
const { SESSION_FILE, readCodexSession, writeCodexSession } = require("./codexSessionStore");
const { readJsonSafe, writeJsonAtomic } = require("./fsUtils");
const { acquireSessionLifecycleLock } = require("./sessionLifecycleLock");
const { findClosure } = require("./taskClosureStore");

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_STATE_FILE = "codex-session-cleanup-state.json";

function terminalTimestamp(queueDir, taskId, sessionId) {
  const closure = findClosure(queueDir, taskId);
  if (closure) return Date.parse(closure.closed_at);

  const approval = findApproval(queueDir, taskId);
  if (!approval || approval.status !== "done" || !approval.event ||
      approval.event.codex_session_id !== sessionId || !approval.event.publish ||
      approval.event.publish.status !== "success") {
    return null;
  }
  const finishedAt = Date.parse(approval.event.publish.finished_at);
  return Number.isFinite(finishedAt) ? finishedAt : null;
}

function shortError(error) {
  return String((error && error.message) || error || "Codex session 刪除失敗")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 500) || "Codex session 刪除失敗";
}

async function cleanupExpiredCodexSessions(deps) {
  const queueDir = deps.queueDir;
  const nowDate = (deps.now || (() => new Date()))();
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();
  const deleteSession = deps.deleteSession || deleteCodexSession;
  const logger = deps.logger;
  const result = { scanned: 0, deleted: 0, skipped: 0, failed: 0, warnings: 0 };
  const workRoot = path.join(queueDir, "work");

  let entries;
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const taskId = entry.name;
    const workDir = path.join(workRoot, taskId);
    if (!fs.existsSync(path.join(workDir, SESSION_FILE))) continue;
    result.scanned++;

    let release;
    try {
      release = acquireSessionLifecycleLock(queueDir, taskId);
    } catch (error) {
      if (error && error.code === "SESSION_CLEANUP_BUSY") {
        result.skipped++;
        continue;
      }
      throw error;
    }

    try {
      let session = readCodexSession(workDir, taskId);
      if (!session || session.deleted_at) {
        result.skipped++;
        continue;
      }
      const terminalAt = terminalTimestamp(queueDir, taskId, session.session_id);
      if (!Number.isFinite(terminalAt) || nowMs - terminalAt < RETENTION_MS) {
        result.skipped++;
        continue;
      }

      const allIds = [
        ...(session.superseded_sessions || []).map((item) => item.session_id),
        session.session_id,
      ];
      const deletedIds = new Set(session.deleted_session_ids || []);
      const warnings = session.delete_warning ? [session.delete_warning] : [];
      const errors = [];
      for (const sessionId of allIds) {
        if (deletedIds.has(sessionId)) continue;
        try {
          const deletion = await deleteSession(sessionId);
          deletedIds.add(sessionId);
          if (deletion && deletion.metadataDeleted === false) {
            const warning = shortError(deletion.warning || "Codex 索引仍有殘留");
            if (!warnings.includes(warning)) warnings.push(warning);
          }
          session = writeCodexSession(workDir, {
            ...session,
            deleted_session_ids: [...deletedIds],
            ...(warnings.length ? { delete_warning: warnings.join("；").slice(0, 500) } : {}),
          });
        } catch (error) {
          errors.push(shortError(error));
        }
      }

      if (errors.length) {
        writeCodexSession(workDir, {
          ...session,
          deleted_session_ids: [...deletedIds],
          delete_attempted_at: nowIso,
          delete_error: errors.join("；").slice(0, 500),
        });
        result.failed++;
        if (logger) logger.error(`[session-cleanup] ${taskId} Codex session 刪除失敗: ${errors.join("；")}`);
        continue;
      }

      const saved = { ...session, deleted_session_ids: [...deletedIds], deleted_at: nowIso };
      delete saved.delete_attempted_at;
      delete saved.delete_error;
      delete saved.delete_warning;
      if (warnings.length) {
        saved.delete_warning = warnings.join("；").slice(0, 500);
        result.warnings++;
      }
      writeCodexSession(workDir, saved);
      result.deleted++;
      if (logger && saved.delete_warning) {
        logger.error(`[session-cleanup] ${taskId} Codex session 內容已刪除，但索引仍有殘留: ${saved.delete_warning}`);
      } else if (logger) logger.log(`[session-cleanup] ${taskId} Codex session 已刪除`);
    } catch (error) {
      result.skipped++;
      if (logger) logger.error(`[session-cleanup] ${taskId} 證據不完整，已跳過: ${shortError(error)}`);
    } finally {
      release();
    }
  }
  return result;
}

function createCodexSessionCleanupScheduler(deps) {
  const nowMs = deps.nowMs || (() => Date.now());
  const stateFile = path.join(deps.queueDir, CLEANUP_STATE_FILE);
  return {
    async poll() {
      const current = nowMs();
      const state = readJsonSafe(stateFile, null);
      const lastRunAt = state && Date.parse(state.last_run_at);
      if (Number.isFinite(lastRunAt) && current - lastRunAt < CLEANUP_INTERVAL_MS) return null;
      writeJsonAtomic(stateFile, { last_run_at: new Date(current).toISOString() });
      return deps.cleanup();
    },
  };
}

module.exports = {
  CLEANUP_INTERVAL_MS,
  CLEANUP_STATE_FILE,
  RETENTION_MS,
  cleanupExpiredCodexSessions,
  createCodexSessionCleanupScheduler,
};
