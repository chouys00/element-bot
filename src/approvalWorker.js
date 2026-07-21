"use strict";
const fs = require("fs");
const path = require("path");
const { approvalExecutor } = require("./executors/approvalExecutor");
const { moveApproval, validateApprovalEvent, writeApproval } = require("./approvalStore");

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

function deadLetterMalformed(queueDir, fromStatus, taskId, error, nowFn, logger) {
  const event = {
    task_id: taskId,
    malformed: true,
    attempt: 0,
    last_error: `approval JSON 解析失敗: ${errorMessage(error)}`,
    failed_at: nowFn().toISOString(),
  };
  moveApproval(queueDir, fromStatus, "failed", taskId);
  writeApproval(queueDir, "failed", event);
  fs.writeFileSync(
    path.join(queueDir, "approvals", "failed", `${taskId}.json.error.txt`),
    event.last_error,
    "utf8"
  );
  if (logger) logger.error(`[approval] ${taskId} JSON 損毀，已移入 failed`);
  return "failed";
}

async function processApproval(filePath, deps) {
  const { queueDir, logger } = deps;
  const executor = deps.executor || approvalExecutor;
  const maxAttempts = deps.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const nowFn = deps.nowFn || (() => new Date());
  const taskId = path.basename(filePath, ".json");

  let event;
  try {
    event = JSON.parse(fs.readFileSync(filePath, "utf8"));
    validateApprovalEvent(queueDir, event, taskId);
  } catch (error) {
    return deadLetterMalformed(queueDir, "pending", taskId, error, nowFn, logger);
  }
  moveApproval(queueDir, "pending", "processing", taskId);
  event.attempt = (event.attempt || 0) + 1;
  if (event.reconciliation_pending) {
    event.reconciliation_pending = false;
    event.reconciliation_attempted = true;
  }
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
    let event;
    try {
      event = JSON.parse(fs.readFileSync(path.join(processingDir, file), "utf8"));
      validateApprovalEvent(queueDir, event, taskId);
    } catch (error) {
      deadLetterMalformed(queueDir, "processing", taskId, error, () => new Date(), logger);
      continue;
    }
    if (event.result && event.result.status === "success" && event.completed_at) {
      moveApproval(queueDir, "processing", "done", taskId);
      if (logger) logger.log(`[approval] 復原已完成發布 ${taskId}`);
      recovered++;
      continue;
    }
    if (event.failed_at && event.last_error) {
      moveApproval(queueDir, "processing", "failed", taskId);
      if (logger) logger.error(`[approval] 復原已確認失敗的發布 ${taskId}`);
      continue;
    }
    if ((event.attempt || 0) >= maxAttempts) {
      if (!event.reconciliation_attempted) {
        event.reconciliation_pending = true;
        event.last_error = event.last_error || "發布結果不確定，將依 Task-ID 對帳一次";
        writeApproval(queueDir, "processing", event);
        moveApproval(queueDir, "processing", "pending", taskId);
        if (logger) logger.log(`[approval] ${taskId} 發布結果不確定，排入 Task-ID 對帳`);
        recovered++;
        continue;
      }
      event.outcome_unknown = true;
      event.unknown_at = new Date().toISOString();
      event.last_error = "Task-ID 對帳期間再次中斷，發布結果未知";
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "unknown", taskId);
      if (logger) logger.error(`[approval] ${taskId} 對帳中斷，移入 unknown`);
      continue;
    }
    moveApproval(queueDir, "processing", "pending", taskId);
    if (logger) logger.log(`[approval] 回收中斷的發布事件 ${taskId}`);
    recovered++;
  }
  return recovered;
}

module.exports = { pollApprovals, processApproval, recoverApprovals };
