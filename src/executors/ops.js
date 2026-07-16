"use strict";
const { runCodex: invokeCodex } = require("../codexRunner");
const { TASK_RESULT_SCHEMA } = require("./taskResult");

// 執行期 provider 邊界只存在於 codexRunner；ops 不自行組合 CLI 參數。
function runCodex(prompt, projectDir) {
  return invokeCodex(prompt, {
    mode: "execute",
    cwd: projectDir,
    outputSchema: TASK_RESULT_SCHEMA,
  });
}

module.exports = { runCodex };
