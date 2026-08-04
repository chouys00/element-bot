"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir, writeJsonAtomic } = require("./fsUtils");
const { isCodexSessionId, readCodexSession } = require("./codexSessionStore");

const APPROVAL_STATUSES = ["pending", "processing", "done", "failed", "unknown"];
const COMPANY_ID_PATTERN = /^[A-Za-z]+\.[A-Za-z]+$/;
const APPROVAL_MESSAGE = "提交代碼並推送";
const LEGACY_APPROVAL_MESSAGES = new Set(["提交代碼"]);
const PUBLISH_STATUSES = new Set(["pending", "processing", "success", "failed", "unknown"]);

function safeId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 240 &&
    !(id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0"));
}

function requireStatus(status) {
  if (!APPROVAL_STATUSES.includes(status)) throw new Error(`未知 approval status: ${status}`);
}

function approvalPath(queueDir, status, taskId) {
  requireStatus(status);
  if (!safeId(taskId)) throw new Error("approval task_id 不合法");
  return path.join(queueDir, "approvals", status, taskId + ".json");
}

function readEvent(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findApproval(queueDir, taskId) {
  if (!safeId(taskId)) throw new Error("approval task_id 不合法");
  for (let scan = 0; scan < 3; scan++) {
    const found = [];
    for (const status of APPROVAL_STATUSES) {
      const file = approvalPath(queueDir, status, taskId);
      try {
        found.push({ status, event: readEvent(file) });
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    if (found.length > 1) {
      if (scan < 2) continue;
      throw new Error(`approval 狀態重複: ${taskId}`);
    }
    if (found.length === 1) return found[0];
  }
  return null;
}

function writeJsonExclusive(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function validateInput(taskId, task, approvedBy) {
  if (!safeId(taskId)) throw new Error("approval task_id 不合法");
  if (!task || task.task !== "skill-dispatch") throw new Error("approval 只支援 skill-dispatch");
  if (typeof task.project_path !== "string" || !task.project_path.trim()) {
    throw new Error("approval 缺 project_path");
  }
  if (typeof task.target_branch !== "string" || !task.target_branch.trim() ||
      task.target_branch.length > 255 || /[\u0000-\u001f\u007f]/.test(task.target_branch)) {
    throw new Error("approval 缺少或含不合法 target_branch");
  }
  if (typeof approvedBy !== "string" || !COMPANY_ID_PATTERN.test(approvedBy.trim())) {
    throw new Error("公司 ID 格式不合法（例如 patrick.zyx）");
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateGitIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("approval event git_identity 不合法");
  }
  if (typeof identity.previous_local_name_present !== "boolean") {
    throw new Error("approval event git_identity.previous_local_name_present 不合法");
  }
  if (identity.previous_local_name_present) {
    if (typeof identity.previous_local_name !== "string" || /[\u0000\u000a\u000d]/.test(identity.previous_local_name)) {
      throw new Error("approval event git_identity.previous_local_name 不合法");
    }
  } else if (identity.previous_local_name !== null) {
    throw new Error("approval event git_identity.previous_local_name 不合法");
  }
  if (typeof identity.applied_name !== "string" || !identity.applied_name ||
      identity.applied_name.length > 100 || /[\u0000-\u001f\u007f]/.test(identity.applied_name)) {
    throw new Error("approval event git_identity.applied_name 不合法");
  }
  if (!validTimestamp(identity.prepared_at)) {
    throw new Error("approval event git_identity.prepared_at 不合法");
  }
  for (const key of ["applied_at", "restored_at"]) {
    if (identity[key] !== undefined && !validTimestamp(identity[key])) {
      throw new Error(`approval event git_identity.${key} 不合法`);
    }
  }
  if (identity.restore_error !== undefined &&
      (typeof identity.restore_error !== "string" || !identity.restore_error)) {
    throw new Error("approval event git_identity.restore_error 不合法");
  }
}

function validatePublish(publish) {
  if (!publish || typeof publish !== "object" || Array.isArray(publish)) {
    throw new Error("approval event publish 不合法");
  }
  if (!PUBLISH_STATUSES.has(publish.status)) {
    throw new Error("approval event publish.status 不合法");
  }
  const textFields = ["remote", "branch", "commit_subject", "committer_name", "error"];
  for (const key of textFields) {
    if (publish[key] !== undefined &&
        (typeof publish[key] !== "string" || !publish[key] || /[\u0000-\u001f\u007f]/.test(publish[key]))) {
      throw new Error(`approval event publish.${key} 不合法`);
    }
  }
  for (const key of ["before_head", "commit_id"]) {
    if (publish[key] !== undefined && !/^[0-9a-f]{40,64}$/i.test(String(publish[key]))) {
      throw new Error(`approval event publish.${key} 不合法`);
    }
  }
  for (const key of ["started_at", "finished_at"]) {
    if (publish[key] !== undefined && !validTimestamp(publish[key])) {
      throw new Error(`approval event publish.${key} 不合法`);
    }
  }
  if (publish.identity_mismatch !== undefined && typeof publish.identity_mismatch !== "boolean") {
    throw new Error("approval event publish.identity_mismatch 不合法");
  }
  if (publish.status === "processing") {
    for (const key of ["before_head", "remote", "branch", "started_at"]) {
      if (publish[key] === undefined) throw new Error(`approval event publish.${key} 不合法`);
    }
  }
  if (publish.status === "success") {
    for (const key of [
      "before_head", "remote", "branch", "started_at", "commit_id", "commit_subject",
      "committer_name", "identity_mismatch", "finished_at",
    ]) {
      if (publish[key] === undefined) throw new Error(`approval event publish.${key} 不合法`);
    }
  }
}

function validateApprovalEvent(queueDir, event, expectedTaskId) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("approval event 必須是物件");
  if (!safeId(event.task_id) || event.task_id !== expectedTaskId) throw new Error("approval event task_id 與檔名不符");
  if (typeof event.project_path !== "string" || !event.project_path.trim() ||
      /[\u0000-\u001f\u007f]/.test(event.project_path)) {
    throw new Error("approval event project_path 不合法");
  }
  if (event.workspace_path !== undefined) {
    const expectedWorkspace = path.resolve(queueDir, "work", expectedTaskId, "workspace");
    if (typeof event.workspace_path !== "string" || path.resolve(event.workspace_path) !== expectedWorkspace) {
      throw new Error("approval event workspace_path 不是此 Task 的舊版專屬工作區");
    }
    let workspaceStat;
    try { workspaceStat = fs.statSync(expectedWorkspace); } catch (_) {}
    if (!workspaceStat || !workspaceStat.isDirectory()) throw new Error("approval event workspace_path 不存在");
  }
  if (typeof event.target_branch !== "string" || !event.target_branch.trim() ||
      event.target_branch.length > 255 || /[\u0000-\u001f\u007f]/.test(event.target_branch)) {
    throw new Error("approval event target_branch 不合法");
  }
  if (typeof event.approved_by !== "string" || !event.approved_by.trim() || event.approved_by.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(event.approved_by)) {
    throw new Error("approval event approved_by 不合法");
  }
  if (typeof event.approved_at !== "string" || !Number.isFinite(Date.parse(event.approved_at))) {
    throw new Error("approval event approved_at 不合法");
  }
  if (event.message !== undefined &&
      event.message !== APPROVAL_MESSAGE &&
      !LEGACY_APPROVAL_MESSAGES.has(event.message)) {
    throw new Error("approval event message 不合法");
  }
  if (event.codex_session_id !== undefined && !isCodexSessionId(event.codex_session_id)) {
    throw new Error("approval event codex_session_id 不合法");
  }
  if (!Number.isInteger(event.attempt) || event.attempt < 0) throw new Error("approval event attempt 不合法");
  if (event.retry_count !== undefined && (!Number.isInteger(event.retry_count) || event.retry_count < 0)) {
    throw new Error("approval event retry_count 不合法");
  }
  if (event.git_identity !== undefined) validateGitIdentity(event.git_identity);
  if (event.publish !== undefined) validatePublish(event.publish);
  return event;
}

function resumableSession(queueDir, taskId, expectedSessionId) {
  const session = readCodexSession(path.join(queueDir, "work", taskId), taskId);
  if (!session) {
    const error = new Error("找不到原始 Codex session，請重新執行任務後再驗收");
    error.code = "CODEX_SESSION_MISSING";
    throw error;
  }
  if (session.deleted_at) {
    const error = new Error("Codex session 已超過保存期限並刪除，無法驗收或重試");
    error.code = "CODEX_SESSION_DELETED";
    throw error;
  }
  if (expectedSessionId && session.session_id !== expectedSessionId) {
    const error = new Error("驗收事件與目前 Codex session 不一致，請重新執行任務");
    error.code = "CODEX_SESSION_MISSING";
    throw error;
  }
  return session;
}

function createApproval(queueDir, taskId, task, approvedBy, nowFn = () => new Date()) {
  validateInput(taskId, task, approvedBy);
  const existing = findApproval(queueDir, taskId);
  if (existing) return { created: false, ...existing };

  let projectStat;
  try { projectStat = fs.statSync(path.resolve(task.project_path)); } catch (_) {}
  if (!projectStat || !projectStat.isDirectory()) {
    throw new Error("找不到 project_path");
  }

  const session = resumableSession(queueDir, taskId);

  const event = {
    task_id: taskId,
    project_path: task.project_path,
    target_branch: task.target_branch,
    approved_by: approvedBy.trim(),
    approved_at: nowFn().toISOString(),
    message: APPROVAL_MESSAGE,
    codex_session_id: session.session_id,
    attempt: 0,
    publish: { status: "pending" },
  };

  validateApprovalEvent(queueDir, event, taskId);
  const file = approvalPath(queueDir, "pending", taskId);
  try {
    writeJsonExclusive(file, event);
    return { created: true, status: "pending", event };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const raced = findApproval(queueDir, taskId);
    if (!raced) throw error;
    return { created: false, ...raced };
  }
}

function writeApproval(queueDir, status, event) {
  requireStatus(status);
  if (!event || !safeId(event.task_id)) throw new Error("approval task_id 不合法");
  return writeJsonAtomic(approvalPath(queueDir, status, event.task_id), event);
}

function moveApproval(queueDir, fromStatus, toStatus, taskId) {
  const from = approvalPath(queueDir, fromStatus, taskId);
  const to = approvalPath(queueDir, toStatus, taskId);
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
  return to;
}

function retryApproval(queueDir, taskId) {
  const existing = findApproval(queueDir, taskId);
  if (!existing) throw new Error("找不到驗收事件");
  if (!["failed", "unknown"].includes(existing.status) || !existing.event.publish) {
    throw new Error("只有 failed 或 unknown 的推送事件可以重試");
  }
  resumableSession(queueDir, taskId, existing.event.codex_session_id);
  const publish = { ...existing.event.publish, status: "pending" };
  delete publish.error;
  delete publish.finished_at;
  const event = {
    ...existing.event,
    publish,
  };
  writeApproval(queueDir, existing.status, event);
  moveApproval(queueDir, existing.status, "pending", taskId);
  return { status: "pending", event };
}

module.exports = {
  APPROVAL_STATUSES,
  approvalPath,
  createApproval,
  findApproval,
  moveApproval,
  retryApproval,
  validateApprovalEvent,
  writeApproval,
};
