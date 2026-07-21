"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir, writeJsonAtomic } = require("./fsUtils");

const APPROVAL_STATUSES = ["pending", "processing", "done", "failed"];

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
  const found = [];
  for (const status of APPROVAL_STATUSES) {
    const file = approvalPath(queueDir, status, taskId);
    if (fs.existsSync(file)) found.push({ status, event: readEvent(file) });
  }
  if (found.length > 1) throw new Error(`approval 狀態重複: ${taskId}`);
  return found[0] || null;
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
  if (typeof approvedBy !== "string" || !approvedBy.trim() || approvedBy.trim().length > 100 ||
      /[\u0000-\u001f\u007f]/.test(approvedBy)) {
    throw new Error("驗收人姓名不合法");
  }
}

function createApproval(queueDir, taskId, task, approvedBy, nowFn = () => new Date()) {
  validateInput(taskId, task, approvedBy);
  const existing = findApproval(queueDir, taskId);
  if (existing) return { created: false, ...existing };

  const event = {
    task_id: taskId,
    project_path: task.project_path,
    target_branch: task.target_branch,
    approved_by: approvedBy.trim(),
    approved_at: nowFn().toISOString(),
    attempt: 0,
  };
  const file = approvalPath(queueDir, "pending", taskId);
  ensureDir(path.dirname(file));
  try {
    fs.writeFileSync(file, JSON.stringify(event, null, 2), { encoding: "utf8", flag: "wx" });
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

module.exports = {
  APPROVAL_STATUSES,
  approvalPath,
  createApproval,
  findApproval,
  moveApproval,
  writeApproval,
};
