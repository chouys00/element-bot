"use strict";
const assert = require("assert");
const { TASK_RESULT_SCHEMA, parseTaskResult, queueStatus } = require("../src/executors/taskResult");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

const valid = {
  status: "success",
  summary: "已完成",
  changes: [],
  validation: [{ command: "npm test", status: "passed", detail: "all passed" }],
  commits: [],
  warnings: [],
};

assert.deepStrictEqual(parseTaskResult(JSON.stringify(valid)), valid);
passed++;
ok("success 映射 done", queueStatus("success") === "done");
ok("failed 映射 failed", queueStatus("failed") === "failed");
ok("blocked 映射 blocked", queueStatus("blocked") === "blocked");
ok("partial 映射 review", queueStatus("partial") === "review");
assert.throws(() => parseTaskResult("not json"), /結果回報格式錯誤/);
passed++;
assert.throws(() => parseTaskResult('{"status":"success"}'), /結果回報格式錯誤/);
passed++;
assert.throws(() => parseTaskResult(JSON.stringify({ ...valid, status: "unknown" })), /結果回報格式錯誤/);
passed++;
assert.throws(() => parseTaskResult(JSON.stringify({ ...valid, validation: [{ command: "x", status: "maybe", detail: "x" }] })), /結果回報格式錯誤/);
passed++;
assert.deepStrictEqual(TASK_RESULT_SCHEMA.required,
  ["status", "summary", "changes", "validation", "commits", "warnings"]);
passed++;

console.log(`taskResult.test.js: ${passed} 項通過 ✅`);
