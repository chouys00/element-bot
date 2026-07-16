"use strict";
const assert = require("assert");
const taskResult = require("../src/executors/taskResult");

const {
  TASK_RESULT_SCHEMA,
  parseTaskResult,
  queueStatus,
  validateTaskResult,
} = taskResult;

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; }

assert.deepStrictEqual(
  Object.keys(taskResult).sort(),
  ["TASK_RESULT_SCHEMA", "parseTaskResult", "queueStatus", "validateTaskResult"].sort(),
  "任務結果模組只保留 generic 公開介面"
);
passed++;

assert.deepStrictEqual(TASK_RESULT_SCHEMA.required, ["status", "output"]);
passed++;

const success = { status: "success", output: "任務已完成。" };
assert.deepStrictEqual(parseTaskResult(JSON.stringify(success)), success);
assert.deepStrictEqual(validateTaskResult(success), success);
passed += 2;

for (const status of ["failed", "blocked", "partial"]) {
  const result = { status, output: status };
  assert.deepStrictEqual(parseTaskResult(JSON.stringify(result)), result);
  passed++;
}

assert.throws(
  () => parseTaskResult(JSON.stringify({
    status: "success",
    summary: "舊格式",
    changes: [],
    validation: [],
    commits: [],
    warnings: [],
  })),
  /Codex 結果回報格式錯誤/
);
passed++;

assert.throws(() => parseTaskResult("not json"), /Codex 結果回報格式錯誤/);
assert.throws(() => parseTaskResult('{"status":"success"}'), /Codex 結果回報格式錯誤/);
assert.throws(() => parseTaskResult(JSON.stringify({ ...success, status: "unknown" })), /Codex 結果回報格式錯誤/);
assert.throws(() => parseTaskResult(JSON.stringify({ ...success, changes: [] })), /Codex 結果回報格式錯誤/);
passed += 4;

ok("success 對應 done", queueStatus("success") === "done");
ok("failed 對應 failed", queueStatus("failed") === "failed");
ok("blocked 對應 blocked", queueStatus("blocked") === "blocked");
ok("partial 對應 review", queueStatus("partial") === "review");
assert.throws(() => queueStatus("unknown"), /Codex 結果回報格式錯誤/);
passed++;

console.log(`taskResult.test.js: ${passed} 項通過 ✅`);
