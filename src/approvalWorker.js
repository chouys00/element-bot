"use strict";
const fs = require("fs");
const path = require("path");
const { approvalExecutor } = require("./executors/approvalExecutor");
const { findApproval, moveApproval, writeApproval } = require("./approvalStore");

const DEFAULT_MAX_ATTEMPTS = 3;

function errorMessage(error) {
  return String((error && error.message) || error || "未知發布錯誤");
}

function resultError(result) {
  if (result && result.status === "success") return null;
  const status = result && result.status ? result.status : "unknown";
  const output = result && result.output ? `: ${result.output}` : "";
  return new Error(`專案發布回報 ${status}${output}`);
}

async function processApproval(filePath, deps) {
  const { queueDir, logger } = deps;
  const executor = deps.executor || approvalExecutor;
  const maxAttempts = deps.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const nowFn = deps.nowFn || (() => new Date());
  const taskId = path.basename(filePath, ".json");

  const processingPath = moveApproval(queueDir, "pending", "processing", taskId);
  let event = JSON.parse(fs.readFileSync(processingPath, "utf8"));
  event.attempt = (event.attempt || 0) + 1;
  delete event.completed_at;
  delete event.failed_at;
  writeApproval(queueDir, "processing", event);

  try {
    const result = await executor(event);
    const failure = resultError(result);
    if (failure) throw failure;
    event = { ...event, result, completed_at: nowFn().toISOString() };
    delete event.last_error;
    writeApproval(queueDir, "processing", event);
    moveApproval(queueDir, "processing", "done", taskId);
    if (logger) logger.log(`[approval] ${taskId} 已完成發布`);
    return "done";
  } catch (error) {
    event.last_error = errorMessage(error);
    if (event.attempt >= maxAttempts) {
      event.failed_at = nowFn().toISOString();
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "failed", taskId);
      if (logger) logger.error(`[approval] ${taskId} 發布失敗，已達重試上限:`, event.last_error);
      return "failed";
    }
    writeApproval(queueDir, "processing", event);
    moveApproval(queueDir, "processing", "pending", taskId);
    if (logger) logger.error(`[approval] ${taskId} 發布失敗，稍後自動重試:`, event.last_error);
    return "retry";
  }
}

async function pollApprovals(deps) {
  const pendingDir = path.join(deps.queueDir, "approvals", "pending");
  let files;
  try { files = fs.readdirSync(pendingDir).filter((file) => file.endsWith(".json")).sort(); }
  catch (_) { return 0; }
  for (const file of files) {
    await processApproval(path.join(pendingDir, file), deps);
  }
  return files.length;
}

function recoverApprovals(queueDir, logger, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const processingDir = path.join(queueDir, "approvals", "processing");
  let files;
  try { files = fs.readdirSync(processingDir).filter((file) => file.endsWith(".json")).sort(); }
  catch (_) { return 0; }
  let recovered = 0;
  for (const file of files) {
    const taskId = file.replace(/\.json$/, "");
    const current = findApproval(queueDir, taskId);
    const event = current.event;
    if ((event.attempt || 0) >= maxAttempts) {
      event.last_error = event.last_error || "worker 中斷且已達重試上限";
      event.failed_at = new Date().toISOString();
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "failed", taskId);
      if (logger) logger.error(`[approval] ${taskId} 中斷後已達重試上限，移入 failed`);
      continue;
    }
    moveApproval(queueDir, "processing", "pending", taskId);
    if (logger) logger.log(`[approval] 回收中斷的發布事件 ${taskId}`);
    recovered++;
  }
  return recovered;
}

module.exports = { pollApprovals, processApproval, recoverApprovals };
