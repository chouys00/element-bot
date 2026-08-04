"use strict";
const fs = require("fs");
const path = require("path");
const { approvalExecutor } = require("./executors/approvalExecutor");
const defaultGitIdentity = require("./approvalGitIdentity");
const defaultGitVerification = require("./approvalGitVerification");
const { moveApproval, validateApprovalEvent, writeApproval } = require("./approvalStore");

function errorMessage(error) {
  return String((error && (error.gitDetail || error.message)) || error || "未知錯誤")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
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
  const gitVerification = deps.gitVerification || defaultGitVerification;
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
  if (event.git_identity && !event.git_identity.restored_at) {
    const previousIdentity = {
      present: event.git_identity.previous_local_name_present,
      value: event.git_identity.previous_local_name,
    };
    try {
      await gitIdentity.restoreLocalUserName(event.project_path, previousIdentity);
      event.git_identity.restored_at = nowFn().toISOString();
      delete event.git_identity.restore_error;
    } catch (error) {
      const restoreMessage = errorMessage(error);
      event.git_identity.restore_error = restoreMessage;
      event.last_error = `Git local user.name 補還原失敗，專案可能殘留驗收人名稱: ${restoreMessage}`;
      event.failed_at = nowFn().toISOString();
      if (event.publish) {
        event.publish = {
          ...event.publish,
          status: "failed",
          error: event.last_error,
          finished_at: event.failed_at,
        };
      }
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "failed", taskId);
      if (logger) logger.error(`[approval] ${taskId} Git 身分補還原失敗:`, restoreMessage);
      return "failed";
    }
  }
  const startedAt = nowFn().toISOString();
  if (event.publish) {
    try {
      if (!event.publish.before_head) {
        const prepared = await gitVerification.preparePublishVerification(
          event.project_path,
          event.target_branch,
        );
        event.publish = {
          status: "processing",
          ...prepared,
          started_at: startedAt,
        };
      } else {
        event.publish = { ...event.publish, status: "processing", started_at: startedAt };
        delete event.publish.finished_at;
        delete event.publish.error;
      }
    } catch (error) {
      event.publish = {
        ...event.publish,
        status: "failed",
        error: errorMessage(error),
        finished_at: nowFn().toISOString(),
      };
      event.last_error = event.publish.error;
      event.failed_at = event.publish.finished_at;
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "failed", taskId);
      if (logger) logger.error(`[approval] ${taskId} 無法準備推送驗證:`, event.last_error);
      return "failed";
    }
  }
  writeApproval(queueDir, "processing", event);

  if (event.publish && event.attempt > 1) {
    let existing;
    try {
      existing = await gitVerification.verifyPublishedCommit(
        event.project_path,
        event.publish,
        event.approved_by,
      );
    } catch (error) {
      existing = { status: "unknown", error: errorMessage(error) };
    }
    if (existing.status === "success") {
      event.publish = {
        ...event.publish,
        ...existing,
        finished_at: nowFn().toISOString(),
      };
      event.delivered_at = event.publish.finished_at;
      delete event.last_error;
      delete event.failed_at;
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "done", taskId);
      if (logger) logger.log(`[approval] ${taskId} 重試前已確認推送成功`);
      return "done";
    }
    if (existing.status === "unknown") {
      event.publish = {
        ...event.publish,
        ...existing,
        finished_at: nowFn().toISOString(),
      };
      event.last_error = existing.error;
      writeApproval(queueDir, "processing", event);
      moveApproval(queueDir, "processing", "unknown", taskId);
      if (logger) logger.error(`[approval] ${taskId} 推送結果無法確認:`, event.last_error);
      return "unknown";
    }
  }

  let result;
  let processError = null;
  let restoreError = null;
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
      } catch (error) {
        const restoreMessage = errorMessage(error);
        event.git_identity.restore_error = restoreMessage;
        restoreError = new Error(
          `Git local user.name 還原失敗，專案可能殘留驗收人名稱: ${restoreMessage}`,
        );
      }
      writeApproval(queueDir, "processing", event);
    }
  }

  let publishResult = null;
  if (!restoreError && event.publish) {
    try {
      publishResult = await gitVerification.verifyPublishedCommit(
        event.project_path,
        event.publish,
        event.approved_by,
      );
    } catch (error) {
      publishResult = { status: "unknown", error: errorMessage(error) };
    }
  }

  if (event.publish && publishResult && publishResult.status === "success") {
    event = {
      ...event,
      result,
      delivered_at: nowFn().toISOString(),
      publish: {
        ...event.publish,
        ...publishResult,
        finished_at: nowFn().toISOString(),
      },
    };
    delete event.last_error;
    delete event.failed_at;
    writeApproval(queueDir, "processing", event);
    moveApproval(queueDir, "processing", "done", taskId);
    if (logger) logger.log(`[approval] ${taskId} 已送達「提交代碼並推送」通知`);
    return "done";
  }

  if (!event.publish && !processError && !restoreError) {
    event = {
      ...event,
      result,
      delivered_at: nowFn().toISOString(),
    };
    delete event.last_error;
    delete event.failed_at;
    writeApproval(queueDir, "processing", event);
    moveApproval(queueDir, "processing", "done", taskId);
    if (logger) logger.log(`[approval] ${taskId} 已送達舊版驗收通知`);
    return "done";
  }

  const finalStatus = restoreError ? "failed" : ((publishResult && publishResult.status) || "failed");
  const verificationError = publishResult && publishResult.error;
  event.last_error = [restoreError, processError, verificationError]
    .filter(Boolean)
    .map(errorMessage)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join("；") || "推送驗證失敗";
  event.failed_at = nowFn().toISOString();
  if (event.publish) {
    event.publish = {
      ...event.publish,
      status: finalStatus === "unknown" ? "unknown" : "failed",
      error: event.last_error,
      finished_at: event.failed_at,
    };
  }
  writeApproval(queueDir, "processing", event);
  moveApproval(queueDir, "processing", finalStatus === "unknown" ? "unknown" : "failed", taskId);
  if (logger) logger.error(`[approval] ${taskId} 推送${finalStatus === "unknown" ? "結果無法確認" : "失敗"}:`, event.last_error);
  return finalStatus === "unknown" ? "unknown" : "failed";
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

function recoveryCandidates(queueDir) {
  const candidates = [];
  for (const status of ["processing", "failed", "unknown"]) {
    let files;
    try {
      files = fs.readdirSync(path.join(queueDir, "approvals", status))
        .filter((file) => file.endsWith(".json"));
    } catch (_) {
      continue;
    }
    for (const file of files) {
      if (status === "processing") {
        candidates.push({ status, file });
        continue;
      }
      try {
        const event = JSON.parse(fs.readFileSync(path.join(queueDir, "approvals", status, file), "utf8"));
        if (event.publish && event.git_identity && !event.git_identity.restored_at) {
          candidates.push({ status, file });
        }
      } catch (_) {}
    }
  }
  return candidates.sort((a, b) => a.file.localeCompare(b.file) || a.status.localeCompare(b.status));
}

function persistRecovered(queueDir, fromStatus, toStatus, taskId, event) {
  writeApproval(queueDir, fromStatus, event);
  if (fromStatus !== toStatus) moveApproval(queueDir, fromStatus, toStatus, taskId);
}

async function recoverApprovals(queueDir, logger, nowFn = () => new Date(), deps = {}) {
  const gitIdentity = deps.gitIdentity || defaultGitIdentity;
  const gitVerification = deps.gitVerification || defaultGitVerification;
  const candidates = recoveryCandidates(queueDir);
  let recovered = 0;
  const restoreFailures = [];

  for (const candidate of candidates) {
    const { status: fromStatus, file } = candidate;
    const taskId = file.replace(/\.json$/, "");
    let event;
    try {
      event = JSON.parse(fs.readFileSync(path.join(queueDir, "approvals", fromStatus, file), "utf8"));
      validateApprovalEvent(queueDir, event, taskId);
    } catch (error) {
      if (fromStatus === "processing") {
        deadLetterMalformed(queueDir, fromStatus, taskId, error, nowFn, logger);
      }
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
        if (event.publish) {
          event.publish = {
            ...event.publish,
            status: "failed",
            error: event.last_error,
            finished_at: event.failed_at,
          };
        }
        persistRecovered(queueDir, fromStatus, "failed", taskId, event);
        if (logger) logger.error(`[approval] ${taskId} 中斷事件身分還原失敗，不重複通知:`, restoreMessage);
        restoreFailures.push(`${taskId}: ${restoreMessage}`);
        continue;
      }
    }

    if (event.publish) {
      let publishResult;
      try {
        publishResult = await gitVerification.verifyPublishedCommit(
          event.project_path,
          event.publish,
          event.approved_by,
        );
      } catch (error) {
        publishResult = { status: "unknown", error: errorMessage(error) };
      }
      const finishedAt = nowFn().toISOString();
      event.publish = { ...event.publish, ...publishResult, finished_at: finishedAt };
      if (publishResult.status === "success") {
        event.delivered_at = finishedAt;
        delete event.last_error;
        delete event.failed_at;
        persistRecovered(queueDir, fromStatus, "done", taskId, event);
        if (logger) logger.log(`[approval] ${taskId} 重啟後確認推送成功`);
      } else {
        const nextStatus = publishResult.status === "failed" ? "failed" : "unknown";
        event.publish.status = nextStatus;
        event.last_error = publishResult.error || "worker 重啟後無法確認推送結果";
        event.failed_at = finishedAt;
        persistRecovered(queueDir, fromStatus, nextStatus, taskId, event);
        if (logger) logger.error(`[approval] ${taskId} 重啟後推送${nextStatus === "failed" ? "失敗" : "結果無法確認"}:`, event.last_error);
      }
    } else {
      event.delivery_uncertain_at = nowFn().toISOString();
      event.last_error = "worker 重啟時通知可能已送達；為避免重複通知，不再重送";
      persistRecovered(queueDir, fromStatus, "done", taskId, event);
      if (logger) logger.log(`[approval] ${taskId} 舊版中斷事件已結束，不重複通知`);
    }
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
