"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./fsUtils");
const { readState } = require("./executors/checkpoint");

const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.MAX_TASK_ATTEMPTS || "3", 10);

async function safeNotify(deps, info) {
  if (!deps.notify) return;
  try {
    await deps.notify(info);
  } catch (error) {
    if (deps.logger) deps.logger.error("[worker] 通知寫入失敗（不影響任務狀態）:", error.message);
  }
}

function appendGateSummary(queueDir, id, result) {
  const logsDir = ensureDir(path.join(queueDir, "logs"));
  const logFile = path.join(logsDir, `${id}.log`);
  let duplicate = false;
  try {
    const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
      let entry;
      try { entry = JSON.parse(lines[index]); } catch (_) { continue; }
      if (!entry.git_gate) continue;
      duplicate = entry.status === result.status && entry.output === result.reason;
      break;
    }
  } catch (_) {}
  if (!duplicate) {
    fs.appendFileSync(logFile, JSON.stringify({
      status: result.status,
      output: result.reason,
      git_gate: true,
    }) + "\n", "utf8");
  }
}

function movePendingToFailed(filePath, queueDir, base, error) {
  const failedDir = ensureDir(path.join(queueDir, "failed"));
  const dest = path.join(failedDir, base);
  fs.renameSync(filePath, dest);
  fs.writeFileSync(dest + ".error.txt", String((error && error.stack) || error), "utf8");
  return dest;
}

async function runPreflight(filePath, task, deps, id, base) {
  if (task.task !== "skill-dispatch" || typeof deps.preflight !== "function") {
    return "ready";
  }

  const state = readState(path.join(deps.queueDir, "work", id));
  if (state && state.steps && state.steps.prepare === "ok") {
    return "ready";
  }

  let result;
  try {
    result = await deps.preflight(task, { id, queueDir: deps.queueDir });
  } catch (error) {
    movePendingToFailed(filePath, deps.queueDir, base, error);
    if (deps.logger) deps.logger.error(`[worker] ${base} 起跑檢查失敗，已移入 failed/:`, error.message);
    await safeNotify(deps, {
      queueDir: deps.queueDir,
      id,
      status: "failed",
      task,
      error: (error && error.message) || String(error),
    });
    return "failed";
  }

  if (!result || !["ready", "waiting", "blocked"].includes(result.status)) {
    const error = new Error("Git 起跑閘門回傳無效狀態");
    movePendingToFailed(filePath, deps.queueDir, base, error);
    if (deps.logger) deps.logger.error(`[worker] ${base} 起跑檢查失敗，已移入 failed/:`, error.message);
    await safeNotify(deps, { queueDir: deps.queueDir, id, status: "failed", task, error: error.message });
    return "failed";
  }

  if (result.status === "ready") return "ready";

  appendGateSummary(deps.queueDir, id, result);
  if (result.status === "waiting") {
    if (deps.logger) deps.logger.log(`[worker] ${base} 保留在 pending/: ${result.reason}`);
    return "waiting";
  }

  const blockedDir = ensureDir(path.join(deps.queueDir, "blocked"));
  fs.renameSync(filePath, path.join(blockedDir, base));
  const structured = {
    status: "blocked",
    output: result.reason,
    queueStatus: "blocked",
    produced: [],
  };
  if (deps.logger) deps.logger.log(`[worker] ${base} 起跑條件無法成立，已移入 blocked/: ${result.reason}`);
  await safeNotify(deps, {
    queueDir: deps.queueDir,
    id,
    status: "blocked",
    task,
    result: structured,
  });
  return "blocked";
}

// 處理一筆 pending 任務。Git 起跑閘門在搬入 processing 及遞增 attempt 前完成。
async function processOne(filePath, deps) {
  const { queueDir, executor, logger } = deps;
  const failedDir = path.join(queueDir, "failed");
  const base = path.basename(filePath);
  const id = base.replace(/\.json$/, "");

  let task;
  try {
    task = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    ensureDir(failedDir);
    fs.renameSync(filePath, path.join(failedDir, base));
    logger.error(`[worker] ${base} JSON 解析失敗，移入 failed/:`, error.message);
    return "failed";
  }

  const preflightStatus = await runPreflight(filePath, task, deps, id, base);
  if (preflightStatus !== "ready") return preflightStatus;

  const processingDir = ensureDir(path.join(queueDir, "processing"));
  const processingPath = path.join(processingDir, base);
  fs.renameSync(filePath, processingPath);

  try {
    const result = await executor(task, { logger, queueDir, id });
    const status = result && result.queueStatus;
    if (!status) throw new Error("executor 未回傳 queueStatus");
    if (!["done", "failed", "blocked", "review"].includes(status)) {
      throw new Error(`未知的 executor queueStatus: ${status}`);
    }
    const destDir = ensureDir(path.join(queueDir, status));
    fs.renameSync(processingPath, path.join(destDir, base));
    logger.log(`[worker] ${base} 完成，移入 ${status}/`);
    await safeNotify(deps, { queueDir, id, status, task, result });
    return status;
  } catch (error) {
    ensureDir(failedDir);
    const dest = path.join(failedDir, base);
    fs.renameSync(processingPath, dest);
    fs.writeFileSync(dest + ".error.txt", String((error && error.stack) || error), "utf8");
    logger.error(`[worker] ${base} 執行失敗，移入 failed/:`, error.message);
    await safeNotify(deps, {
      queueDir,
      id,
      status: "failed",
      task,
      error: (error && error.message) || String(error),
    });
    return "failed";
  }
}

// 每輪最多執行一筆；等待中的專案不阻擋後方其他可執行專案。
async function pollOnce(deps) {
  const pendingDir = path.join(deps.queueDir, "pending");
  if (!fs.existsSync(pendingDir)) return 0;
  const files = fs.readdirSync(pendingDir).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) return 0;
  for (const file of files) {
    const status = await processOne(path.join(pendingDir, file), deps);
    if (status !== "waiting") return 1;
  }
  return 0;
}

function recoverProcessing(queueDir, logger, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const processingDir = path.join(queueDir, "processing");
  const pendingDir = path.join(queueDir, "pending");
  const failedDir = path.join(queueDir, "failed");
  if (!fs.existsSync(processingDir)) return 0;
  const files = fs.readdirSync(processingDir).filter((file) => file.endsWith(".json"));
  let recovered = 0;
  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    const state = readState(path.join(queueDir, "work", id));
    const attempt = (state && state.attempt) || 0;
    if (attempt >= maxAttempts) {
      ensureDir(failedDir);
      const dest = path.join(failedDir, file);
      fs.renameSync(path.join(processingDir, file), dest);
      fs.writeFileSync(
        dest + ".error.txt",
        `崩潰重試上限：已執行 ${attempt} 次仍未完成；請人工檢查後重跑。`,
        "utf8",
      );
      logger.error(`[worker] ${file} 已執行 ${attempt} 次，移入 failed/（上限 ${maxAttempts}）`);
      continue;
    }
    ensureDir(pendingDir);
    fs.renameSync(path.join(processingDir, file), path.join(pendingDir, file));
    logger.log(`[worker] 回收中斷任務 ${file}（已執行 ${attempt} 次），移回 pending/`);
    recovered++;
  }
  return recovered;
}

module.exports = { processOne, pollOnce, recoverProcessing };
