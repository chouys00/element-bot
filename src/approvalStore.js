"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir, writeJsonAtomic } = require("./fsUtils");

const APPROVAL_STATUSES = ["pending", "processing", "done", "failed", "unknown"];
const COMPANY_ID_PATTERN = /^[A-Za-z]+\.[A-Za-z]+$/;

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

function validateApprovalEvent(queueDir, event, expectedTaskId) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("approval event 必須是物件");
  if (!safeId(event.task_id) || event.task_id !== expectedTaskId) throw new Error("approval event task_id 與檔名不符");
  if (typeof event.project_path !== "string" || !event.project_path.trim() || /[\u0000-\u001f\u007f]/.test(event.project_path)) {
    throw new Error("approval event project_path 不合法");
  }
  const expectedWorkspace = path.resolve(queueDir, "work", expectedTaskId, "workspace");
  if (typeof event.workspace_path !== "string" || path.resolve(event.workspace_path) !== expectedWorkspace) {
    throw new Error("approval event workspace_path 不是此 Task 的專屬工作區");
  }
  let workspaceStat;
  try { workspaceStat = fs.statSync(expectedWorkspace); } catch (_) {}
  if (!workspaceStat || !workspaceStat.isDirectory()) throw new Error("approval event workspace_path 不存在");
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
  if (!Number.isInteger(event.attempt) || event.attempt < 0) throw new Error("approval event attempt 不合法");
  if (event.retry_count !== undefined && (!Number.isInteger(event.retry_count) || event.retry_count < 0)) {
    throw new Error("approval event retry_count 不合法");
  }
  return event;
}

function createApproval(queueDir, taskId, task, approvedBy, nowFn = () => new Date()) {
  validateInput(taskId, task, approvedBy);
  const existing = findApproval(queueDir, taskId);
  if (existing) return { created: false, ...existing };

  const workspacePath = path.join(queueDir, "work", taskId, "workspace");
  let workspaceStat;
  try { workspaceStat = fs.statSync(workspacePath); } catch (_) {}
  if (!workspaceStat || !workspaceStat.isDirectory()) {
    throw new Error("找不到此 Task 的專屬工作區，禁止發布共用工作目錄的變更");
  }

  const event = {
    task_id: taskId,
    project_path: task.project_path,
    workspace_path: workspacePath,
    target_branch: task.target_branch,
    approved_by: approvedBy.trim(),
    approved_at: nowFn().toISOString(),
    attempt: 0,
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

function retryApproval(queueDir, taskId) {
  const current = findApproval(queueDir, taskId);
  if (!current || !["failed", "unknown"].includes(current.status)) {
    throw new Error("只有發布失敗或結果未知的 approval 可以重試");
  }
  if (current.event.malformed) throw new Error("損毀的 approval 事件不可直接重試");
  validateApprovalEvent(queueDir, current.event, taskId);
  const event = {
    ...current.event,
    attempt: 0,
    retry_count: (current.event.retry_count || 0) + 1,
  };
  for (const key of ["last_error", "failed_at", "unknown_at", "outcome_unknown", "reconciliation_pending", "reconciliation_attempted"]) {
    delete event[key];
  }
  writeApproval(queueDir, current.status, event);
  moveApproval(queueDir, current.status, "pending", taskId);
  return { status: "pending", event };
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
