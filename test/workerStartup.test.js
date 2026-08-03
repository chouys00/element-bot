"use strict";
const assert = require("assert");
const { prepareWorkerRuntime } = require("../src/workerStartup");

(async () => {
  const order = [];
  await assert.rejects(
    () => prepareWorkerRuntime("queue-root", console, {
      recoverApprovals: async (queueDir) => {
        assert.strictEqual(queueDir, "queue-root");
        order.push("recover");
      },
      preflightCodexRuntime: async () => {
        order.push("preflight");
        throw new Error("Codex runtime 不可用");
      },
    }),
    /Codex runtime 不可用/,
  );
  assert.deepStrictEqual(order, ["recover", "preflight"], "即使 Codex 檢查失敗，也必須先補還原驗收 Git 身分");

  let preflightCalled = false;
  await assert.rejects(
    () => prepareWorkerRuntime("queue-root", console, {
      recoverApprovals: async () => { throw new Error("Git 身分補還原失敗"); },
      preflightCodexRuntime: async () => { preflightCalled = true; },
    }),
    /Git 身分補還原失敗/,
  );
  assert.strictEqual(preflightCalled, false, "補還原失敗時不得繼續啟動 worker");

  console.log("workerStartup.test.js: worker 啟動前先補還原驗收 Git 身分通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
