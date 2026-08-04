"use strict";
const path = require("path");
const { readJsonSafe, writeJsonAtomic } = require("./fsUtils");

const SESSION_FILE = "codex-session.json";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCodexSessionId(value) {
  return SESSION_ID_PATTERN.test(String(value || ""));
}

function safeTaskId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240 &&
    !value.includes("..") && !/[\\/\0]/.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateSessionEntry(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !isCodexSessionId(value.session_id) || !validTimestamp(value.created_at)) {
    throw new Error(`Codex session ${label} 不合法`);
  }
  return { session_id: value.session_id, created_at: value.created_at };
}

function validateCodexSession(value, expectedTaskId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex session metadata 必須是物件");
  }
  if (!safeTaskId(value.task_id)) throw new Error("Codex session task_id 不合法");
  if (expectedTaskId && value.task_id !== expectedTaskId) {
    throw new Error(`Codex session task_id 與任務不符: ${value.task_id}`);
  }
  if (!isCodexSessionId(value.session_id)) {
    throw new Error("Codex session session_id 不合法");
  }
  if (!validTimestamp(value.created_at)) throw new Error("Codex session created_at 不合法");
  const superseded = [];
  const seen = new Set([value.session_id]);
  if (value.superseded_sessions !== undefined) {
    if (!Array.isArray(value.superseded_sessions)) {
      throw new Error("Codex session superseded_sessions 不合法");
    }
    for (const item of value.superseded_sessions) {
      const entry = validateSessionEntry(item, "superseded_sessions");
      if (seen.has(entry.session_id)) continue;
      seen.add(entry.session_id);
      superseded.push(entry);
    }
  }
  let deletedSessionIds;
  if (value.deleted_session_ids !== undefined) {
    if (!Array.isArray(value.deleted_session_ids)) {
      throw new Error("Codex session deleted_session_ids 不合法");
    }
    deletedSessionIds = [...new Set(value.deleted_session_ids.map((item) => {
      if (!isCodexSessionId(item) || !seen.has(item)) {
        throw new Error("Codex session deleted_session_ids 不合法");
      }
      return item;
    }))];
  }
  for (const key of ["delete_attempted_at", "deleted_at"]) {
    if (value[key] !== undefined && !validTimestamp(value[key])) {
      throw new Error(`Codex session ${key} 不合法`);
    }
  }
  for (const key of ["delete_error", "delete_warning"]) {
    if (value[key] !== undefined &&
        (typeof value[key] !== "string" || !value[key] ||
         value[key].length > 500 || /[\u0000\u000a\u000d]/.test(value[key]))) {
      throw new Error(`Codex session ${key} 不合法`);
    }
  }
  return {
    task_id: value.task_id,
    session_id: value.session_id,
    created_at: value.created_at,
    ...(superseded.length ? { superseded_sessions: superseded } : {}),
    ...(deletedSessionIds !== undefined ? { deleted_session_ids: deletedSessionIds } : {}),
    ...(value.delete_attempted_at !== undefined ? { delete_attempted_at: value.delete_attempted_at } : {}),
    ...(value.delete_error !== undefined ? { delete_error: value.delete_error } : {}),
    ...(value.delete_warning !== undefined ? { delete_warning: value.delete_warning } : {}),
    ...(value.deleted_at !== undefined ? { deleted_at: value.deleted_at } : {}),
  };
}

function writeCodexSession(workDir, value) {
  let next = validateCodexSession(value);
  const existingRaw = readJsonSafe(path.join(workDir, SESSION_FILE), null);
  if (existingRaw) {
    const existing = validateCodexSession(existingRaw, next.task_id);
    const history = [...(existing.superseded_sessions || [])];
    if (existing.session_id !== next.session_id) {
      history.push({ session_id: existing.session_id, created_at: existing.created_at });
    }
    history.push(...(next.superseded_sessions || []));
    if (history.length) next = validateCodexSession({ ...next, superseded_sessions: history });
    if (existing.session_id === next.session_id && existing.superseded_sessions &&
        !next.superseded_sessions) {
      next = validateCodexSession({ ...next, superseded_sessions: existing.superseded_sessions });
    }
  }
  const session = next;
  writeJsonAtomic(path.join(workDir, SESSION_FILE), session);
  return session;
}

function readCodexSession(workDir, expectedTaskId) {
  const value = readJsonSafe(path.join(workDir, SESSION_FILE), null);
  return value ? validateCodexSession(value, expectedTaskId) : null;
}

module.exports = {
  SESSION_FILE,
  isCodexSessionId,
  readCodexSession,
  validateCodexSession,
  writeCodexSession,
};
