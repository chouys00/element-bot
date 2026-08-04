"use strict";
const fs = require("fs");
const path = require("path");
const { approvalExecutor } = require("./executors/approvalExecutor");
const defaultGitIdentity = require("./approvalGitIdentity");
const { moveApproval, validateApprovalEvent, writeApproval } = require("./approvalStore");

function errorMessage(error) {
  return String((error && error.message) || error || "未知錯誤");
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
    "utf8",
  );
  if (logger) logger.error(`[approval] ${taskId} JSON 損毀，已移入 failed`);
  return "failed";
}

async function processApproval(filePath, deps) {
  const { queueDir, logger } = deps;
  const executor = deps.executor || approvalExecutor;
  const gitIdentity = deps.gitIdentity || defaultGitIdentity;
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
  writeApproval(queueDir, "processing", event);

  let result;
  let processError = null;
  let snapshot = null;
  try {
    snapshot = await gitIdentity.captureLocalUserName(event.project_path);
    event.git_identity = {
      previous_local_name_present: snapshot.present,
      previous_local_name: snapshot.value,
      applied_name: event.approved_by,
      prepared_at: nowFn().toISOString(),
    };
    writeApproval(queueDir, "processing", event);

    await gitIdentity.setLocalUserName(event.project_path, event.approved_by);
    event.git_identity.applied_at = nowFn().toISOString();
    writeApproval(queueDir, "processing", event);
    result = await executor(event);
  } catch (error) {
    processError = error;
  } finally {
    if (snapshot) {
      try {
        await gitIdentity.restoreLocalUserName(event.project_path, snapshot);
        event.git_identity.restored_at = nowFn().toISOString();
        delete event.git_identity.restore_error;
      } catch (restoreError) {
        const restoreMessage = errorMessage(restoreError);
        event.git_identity.restore_error = restoreMessage;
        const prefix = processError ? `${errorMessage(processError)}；` : "";
        processError = new Error(
          `${prefix}Git local user.name 還原失敗，專案可能殘留驗收人名稱: ${restoreMessage}`,
        );
      }
      writeApproval(queueDir, "processing", event);
    }
  }

  if (!processError) {
    event = {
      ...event,
      result,
      delivered_at: nowFn().toISOString(),
    };
    delete event.last_error;
    delete event.failed_at;
    writeApproval(queueDir, "processing", event);
    moveApproval(queueDir, "processing", "done", taskId);
    if (logger) logger.log(`[approval] ${taskId} 已送達「提交代碼並推送」通知`);
    return "done";
  }

  event.last_error = errorMessage(processError);
  event.failed_at = nowFn().toISOString();
  writeApproval(queueDir, "processing", event);
  moveApproval(queueDir, "processing", "failed", taskId);
  if (logger) logger.error(`[approval] ${taskId} 通知失敗，不自動重送:`, event.last_error);
  return "failed";
}

async function pollApprovals(deps) {
  const pendingDir = path.join(deps.queueDir, "approvals", "pending");
  let files;
  try {
    files = fs.readdirSync(pendingDir).filter((file) => file.endsWith(".json")).sort();
  } catch (_) {
    return 0;
  }
  for (const file of files) {
    await processApproval(path.join(pendingDir, file), deps);
  }
  return files.length;
}

async function recoverApprovals(queueDir, logger, nowFn = () => new Date(), deps = {}) {
  const gitIdentity = deps.gitIdentity || defaultGitIdentity;
  const processingDir = path.join(queueDir, "approvals", "processing");
  let files;
  try {
    files = fs.readdirSync(processingDir).filter((file) => file.endsWith(".json")).sort();
  } catch (_) {
    return 0;
  }

  let recovered = 0;
  const restoreFailures = [];
  for (const file of files) {
    const taskId = file.replace(/\.json$/, "");
    let event;
    try {
      event = JSON.parse(fs.readFileSync(path.join(processingDir, file), "utf8"));
      validateApprovalEvent(queueDir, event, taskId);
    } catch (error) {
      deadLetterMalformed(queueDir, "processing", taskId, error, nowFn, logger);
      continue;
    }

    if (event.git_identity && !event.git_identity.restored_at) {
      const snapshot = {
        present: event.git_identity.previous_local_name_present,
        value: event.git_identity.previous_local_name,
      };
      try {
        await gitIdentity.restoreLocalUserName(event.project_path, snapshot);
        event.git_identity.restored_at = nowFn().toISOString();
        delete event.git_identity.restore_error;
      } catch (error) {
        const restoreMessage = errorMessage(error);
        event.git_identity.restore_error = restoreMessage;
        event.last_error = `worker 重啟時 Git local user.name 還原失敗，專案可能殘留驗收人名稱: ${restoreMessage}`;
        event.failed_at = nowFn().toISOString();
        writeApproval(queueDir, "processing", event);
        moveApproval(queueDir, "processing", "failed", taskId);
        if (logger) logger.error(`[approval] ${taskId} 中斷事件身分還原失敗，不重複通知:`, restoreMessage);
        restoreFailures.push(`${taskId}: ${restoreMessage}`);
        continue;
      }
    }

    event.delivery_uncertain_at = nowFn().toISOString();
    event.last_error = "worker 重啟時通知可能已送達；為避免重複通知，不再重送";
    writeApproval(queueDir, "processing", event);
    moveApproval(queueDir, "processing", "done", taskId);
    if (logger) logger.log(`[approval] ${taskId} 中斷事件已結束，不重複通知`);
    recovered++;
  }
  if (restoreFailures.length > 0) {
    throw new Error(
      `worker 重啟時 Git local user.name 還原失敗，專案可能殘留驗收人名稱: ${restoreFailures.join("；")}`,
    );
  }
  return recovered;
}

module.exports = { pollApprovals, processApproval, recoverApprovals };
