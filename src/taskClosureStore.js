"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./fsUtils");

const COMPANY_ID_PATTERN = /^[A-Za-z]+\.[A-Za-z]+$/;

function safeId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 240 &&
    !(id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0"));
}

function closurePath(queueDir, taskId) {
  if (!safeId(taskId)) throw new Error("closure task_id 不合法");
  return path.join(queueDir, "closed", `${taskId}.json`);
}

function validateClosureEvent(event, taskId) {
  if (!event || typeof event !== "object" || Array.isArray(event) || !safeId(taskId) || event.task_id !== taskId) {
    throw new Error("closure event task_id 不合法");
  }
  if (typeof event.closed_by !== "string" || !COMPANY_ID_PATTERN.test(event.closed_by.trim())) {
    throw new Error("closure event closed_by 必須是公司 ID，例如 patrick.zyx");
  }
  if (typeof event.closed_at !== "string" || !Number.isFinite(Date.parse(event.closed_at))) {
    throw new Error("closure event closed_at 不合法");
  }
  return { ...event, closed_by: event.closed_by.trim() };
}

function findClosure(queueDir, taskId) {
  let raw;
  try {
    raw = fs.readFileSync(closurePath(queueDir, taskId), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  return validateClosureEvent(JSON.parse(raw), taskId);
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

function createClosure(queueDir, taskId, closedBy, nowFn = () => new Date()) {
  if (!safeId(taskId)) throw new Error("closure task_id 不合法");
  if (typeof closedBy !== "string" || !COMPANY_ID_PATTERN.test(closedBy.trim())) {
    throw new Error("公司 ID 格式不合法（例如 patrick.zyx）");
  }
  const existing = findClosure(queueDir, taskId);
  if (existing) return { created: false, event: existing };

  const event = validateClosureEvent({
    task_id: taskId,
    closed_by: closedBy.trim(),
    closed_at: nowFn().toISOString(),
  }, taskId);
  try {
    writeJsonExclusive(closurePath(queueDir, taskId), event);
    return { created: true, event };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const raced = findClosure(queueDir, taskId);
    if (!raced) throw error;
    return { created: false, event: raced };
  }
}

function reopenClosure(queueDir, taskId) {
  const file = closurePath(queueDir, taskId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

module.exports = {
  COMPANY_ID_PATTERN,
  closurePath,
  createClosure,
  findClosure,
  reopenClosure,
  validateClosureEvent,
};
