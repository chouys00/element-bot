"use strict";
const { loadConfig } = require("./config");
const { pollOnce, recoverProcessing } = require("./workerCore");
const { checkProjectGit } = require("./projectGitGate");
const { agentExecutor } = require("./executors/agentExecutor");
const { writeNotifyFile } = require("./notify");
const { approvalExecutor } = require("./executors/approvalExecutor");
const { pollApprovals } = require("./approvalWorker");
const { prepareWorkerRuntime } = require("./workerStartup");

async function main() {
  const config = loadConfig();
  const logger = console;
  const runtime = await prepareWorkerRuntime(config.queueDir, logger);
  console.log(`[codex] runtime 已驗證：${runtime.command}；登入=${runtime.login}`);
  const notify = (info) => writeNotifyFile(info);
  const deps = {
    queueDir: config.queueDir,
    executor: agentExecutor,
    preflight: checkProjectGit,
    logger,
    notify,
  };
  const approvalDeps = {
    queueDir: config.queueDir,
    executor: approvalExecutor,
    logger,
  };

  logger.log(`[worker] 已啟動，監看 ${config.queueDir}/pending，每 ${config.pollIntervalMs}ms 處理一筆`);
  recoverProcessing(config.queueDir, logger, config.maxTaskAttempts);

  const loop = async () => {
    try {
      await pollOnce(deps);
      await pollApprovals(approvalDeps);
    } catch (error) {
      logger.error("[worker] 輪詢錯誤:", error.message);
    }
    setTimeout(loop, config.pollIntervalMs);
  };

  loop();
}

main().catch((error) => {
  console.error("[worker] 啟動失敗:", error);
  process.exit(1);
});
