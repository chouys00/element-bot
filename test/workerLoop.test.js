"use strict";
const assert = require("assert");
const { pollWorkerLoop } = require("../src/workerLoop");

(async () => {
  const calls = [];
  const result = await pollWorkerLoop(
    { kind: "tasks" },
    { kind: "approvals" },
    {
      pollApprovals: async (deps) => { calls.push(deps.kind); return 2; },
      cleanupSessions: async () => { calls.push("cleanup"); return { deleted: 0 }; },
      pollOnce: async (deps) => { calls.push(deps.kind); return 1; },
    },
  );
  assert.deepStrictEqual(calls, ["approvals", "cleanup", "tasks"], "每輪先處理驗收，再做低頻清理，最後才處理新任務");
  assert.deepStrictEqual(result, { approvals: 2, tasks: 1 });

  const cleanupErrors = [];
  const afterCleanupFailure = [];
  const failureResult = await pollWorkerLoop({}, {}, {
    pollApprovals: async () => { afterCleanupFailure.push("approvals"); return 0; },
    cleanupSessions: async () => { afterCleanupFailure.push("cleanup"); throw new Error("磁碟暫時無法讀取"); },
    onCleanupError: (error) => cleanupErrors.push(error.message),
    pollOnce: async () => { afterCleanupFailure.push("tasks"); return 1; },
  });
  assert.deepStrictEqual(afterCleanupFailure, ["approvals", "cleanup", "tasks"], "清理失敗不能阻斷任務輪詢");
  assert.deepStrictEqual(cleanupErrors, ["磁碟暫時無法讀取"]);
  assert.deepStrictEqual(failureResult, { approvals: 0, tasks: 1 });
  console.log("workerLoop.test.js: 驗收推送優先順序通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
