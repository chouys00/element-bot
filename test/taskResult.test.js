"use strict";
const assert = require("assert");
const {
  GENERIC_TASK_RESULT_SCHEMA,
  LEGACY_TASK_RESULT_SCHEMA,
  TASK_RESULT_SCHEMA,
  detectTaskResultMode,
  parseTaskResult,
  queueStatus,
  schemaForMode,
  selectedTaskResultMode,
} = require("../src/executors/taskResult");

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

const generic = { status: "success", output: "任務先前已完成，證據為外部識別碼 123。" };
assert.deepStrictEqual(parseTaskResult(JSON.stringify(generic), "generic"), generic);
passed++;
ok("generic 可自動辨識", detectTaskResultMode(generic) === "generic");
ok("預設 generic", selectedTaskResultMode({}) === "generic");
ok("可切回 legacy", selectedTaskResultMode({ TASK_RESULT_MODE: "legacy" }) === "legacy");
ok("模式取得正確 schema",
  schemaForMode("generic") === GENERIC_TASK_RESULT_SCHEMA &&
  schemaForMode("legacy") === LEGACY_TASK_RESULT_SCHEMA);
assert.deepStrictEqual(GENERIC_TASK_RESULT_SCHEMA.required, ["status", "output"]);
passed++;
assert.throws(
  () => parseTaskResult(JSON.stringify({ ...generic, changes: [] }), "generic"),
  /結果回報格式錯誤/
);
passed++;
for (const status of ["failed", "partial", "blocked"]) {
  assert.deepStrictEqual(parseTaskResult(JSON.stringify({ status, output: status }), "generic"), { status, output: status });
  passed++;
}

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
