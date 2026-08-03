"use strict";
const { recoverApprovals } = require("./approvalWorker");
const { preflightCodexRuntime } = require("./codexRunner");

async function prepareWorkerRuntime(queueDir, logger, deps = {}) {
  const recover = deps.recoverApprovals || recoverApprovals;
  const preflight = deps.preflightCodexRuntime || preflightCodexRuntime;
  await recover(queueDir, logger);
  return preflight();
}

module.exports = { prepareWorkerRuntime };
