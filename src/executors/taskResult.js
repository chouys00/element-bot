"use strict";

const RESULT_STATUSES = ["success", "failed", "blocked", "partial"];
const RESULT_KEYS = ["status", "output"];

const TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: RESULT_STATUSES },
    output: { type: "string", minLength: 1 },
  },
  required: RESULT_KEYS,
  additionalProperties: false,
};

function fail(detail) {
  throw new Error(`Codex 結果回報格式錯誤: ${detail}`);
}

function validateTaskResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("結果必須是物件");

  const actual = Object.keys(result).sort();
  const expected = [...RESULT_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("結果欄位不完整或含未知欄位");
  }
  if (!RESULT_STATUSES.includes(result.status)) fail(`未知 status: ${result.status}`);
  if (typeof result.output !== "string" || !result.output.trim()) fail("output 不可為空");
  return result;
}

function parseTaskResult(stdout) {
  let result;
  try { result = JSON.parse(String(stdout || "")); }
  catch (error) { fail(`不是合法 JSON (${error.message})`); }
  return validateTaskResult(result);
}

function queueStatus(resultStatus) {
  const mapping = { success: "done", failed: "failed", blocked: "blocked", partial: "review" };
  if (!mapping[resultStatus]) fail(`未知 status: ${resultStatus}`);
  return mapping[resultStatus];
}

module.exports = { TASK_RESULT_SCHEMA, parseTaskResult, queueStatus, validateTaskResult };
