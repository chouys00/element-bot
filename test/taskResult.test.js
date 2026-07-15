"use strict";
const assert = require("assert");
const {
  MINIMAL_TASK_RESULT_SCHEMA,
  DETAILED_TASK_RESULT_SCHEMA,
  detectTaskResultFormat,
  parseTaskResult,
  queueStatus,
  schemaForFormat,
  selectedTaskResultFormat,
} = require("../src/executors/taskResult");
const ops = require("../src/executors/ops");

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
const minimal = { status: "success", result: "已完成過，無需再次修改。" };
assert.deepStrictEqual(parseTaskResult(JSON.stringify(minimal), "minimal"), minimal);
passed++;
ok("minimal 自動辨識", detectTaskResultFormat(minimal) === "minimal");
ok("minimal schema 只要求 status/result",
  MINIMAL_TASK_RESULT_SCHEMA.required.join(",") === "status,result");
assert.throws(
  () => parseTaskResult(JSON.stringify({ ...minimal, changes: [] }), "minimal"),
  /結果回報格式錯誤/
);
passed++;
assert.throws(
  () => parseTaskResult(JSON.stringify({ status: "blocked", result: "等待" }), "minimal"),
  /結果回報格式錯誤/
);
passed++;
ok("預設 minimal", selectedTaskResultFormat({}) === "minimal");
ok("可切 detailed", selectedTaskResultFormat({ TASK_RESULT_FORMAT: "detailed" }) === "detailed");
{
  const original = process.env.TASK_RESULT_FORMAT;
  delete process.env.TASK_RESULT_FORMAT;
  ok("ops 預設使用 minimal", ops.resultFormat() === "minimal");
  process.env.TASK_RESULT_FORMAT = "detailed";
  ok("ops 可選 detailed", ops.resultFormat() === "detailed");
  if (original === undefined) delete process.env.TASK_RESULT_FORMAT;
  else process.env.TASK_RESULT_FORMAT = original;
}
ok("格式選到對應 schema", schemaForFormat("minimal") === MINIMAL_TASK_RESULT_SCHEMA && schemaForFormat("detailed") === DETAILED_TASK_RESULT_SCHEMA);
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
assert.deepStrictEqual(DETAILED_TASK_RESULT_SCHEMA.required,
  ["status", "summary", "changes", "validation", "commits", "warnings"]);
passed++;

console.log(`taskResult.test.js: ${passed} 項通過 ✅`);
