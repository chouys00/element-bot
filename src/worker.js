"use strict";
const { loadConfig } = require("./config");
const { pollOnce, recoverProcessing } = require("./workerCore");
const { agentExecutor } = require("./executors/agentExecutor");
const { writeNotifyFile } = require("./notify");

async function main() {
  const config = loadConfig();
  const logger = console;
  // 任務結束寫通知檔到 queue/notify/,由 bot 監看發送(worker 沒有 Matrix client)。
  const notify = (info) => writeNotifyFile(info);
  const deps = { queueDir: config.queueDir, executor: agentExecutor, logger, notify };

  logger.log(`[worker] 啟動,監看 ${config.queueDir}/pending,每 ${config.pollIntervalMs}ms 掃描一次`);
  recoverProcessing(config.queueDir, logger, config.maxTaskAttempts);

  // 自排程 loop(非 setInterval):確保上一輪 pollOnce 完成後才排下一輪,
  // 避免未來換成較慢的真實 executor 時發生重入。
  const loop = async () => {
    try {
      await pollOnce(deps);
    } catch (err) {
      logger.error("[worker] 掃描錯誤:", err.message);
    }
    setTimeout(loop, config.pollIntervalMs);
  };

  loop();
}

main().catch((err) => {
  console.error("[worker] 啟動失敗:", err);
  process.exit(1);
});
