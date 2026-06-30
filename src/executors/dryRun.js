"use strict";
// v1 executor:不實際跑 agent,只把任務印出來,直接視為成功。
// 介面:async (task, { logger }) => void;丟出例外代表「失敗」(會被 worker 移到 failed/)。
// 日後替換為真正呼叫 agent 的 executor 時,維持同樣介面即可,bot 與佇列格式皆不動。
async function dryRunExecutor(task, { logger }) {
  logger.log(`[executor:dry-run] 任務 ${task.rule} → ${task.task} params=${JSON.stringify(task.params)}`);
}

module.exports = { dryRunExecutor };
