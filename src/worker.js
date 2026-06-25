"use strict";
const { loadConfig } = require("./config");
const { pollOnce } = require("./workerCore");
const { dryRunExecutor } = require("./executors/dryRun");

async function main() {
  const config = loadConfig();
  const logger = console;
  const deps = { queueDir: config.queueDir, executor: dryRunExecutor, logger };

  logger.log(`[worker] 啟動,監看 ${config.queueDir}/pending,每 ${config.pollIntervalMs}ms 掃描一次`);

  const tick = async () => {
    try {
      await pollOnce(deps);
    } catch (err) {
      logger.error("[worker] 掃描錯誤:", err.message);
    }
  };

  await tick();
  setInterval(tick, config.pollIntervalMs);
}

main().catch((err) => {
  console.error("[worker] 啟動失敗:", err);
  process.exit(1);
});
