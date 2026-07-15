"use strict";

const RESULT_STATUSES = ["success", "failed", "blocked", "partial"];
const VALIDATION_STATUSES = ["passed", "failed", "skipped", "not_applicable"];
const REQUIRED_KEYS = ["status", "summary", "changes", "validation", "commits", "warnings"];
const GENERIC_KEYS = ["status", "output"];

const LEGACY_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: RESULT_STATUSES },
    summary: { type: "string", minLength: 1 },
    changes: { type: "array", items: { type: "string" } },
    validation: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          status: { type: "string", enum: VALIDATION_STATUSES },
          detail: { type: "string" },
        },
        required: ["command", "status", "detail"],
        additionalProperties: false,
      },
    },
    commits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hash: { type: "string" },
          message: { type: "string" },
        },
        required: ["hash", "message"],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: REQUIRED_KEYS,
  additionalProperties: false,
};
const TASK_RESULT_SCHEMA = LEGACY_TASK_RESULT_SCHEMA;

const GENERIC_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: RESULT_STATUSES },
    output: { type: "string", minLength: 1 },
  },
  required: GENERIC_KEYS,
  additionalProperties: false,
};

function fail(detail) {
  throw new Error(`Codex 結果回報格式錯誤: ${detail}`);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必須是物件`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    fail(`${label} 欄位不完整或含未知欄位`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} 必須是字串陣列`);
  }
}

function selectedTaskResultMode(env = process.env) {
  return env.TASK_RESULT_MODE === "legacy" ? "legacy" : "generic";
}

function schemaForMode(mode) {
  return mode === "legacy" ? LEGACY_TASK_RESULT_SCHEMA : GENERIC_TASK_RESULT_SCHEMA;
}

function detectTaskResultMode(result) {
  return result && Object.prototype.hasOwnProperty.call(result, "output") ? "generic" : "legacy";
}

function validateLegacyTaskResult(result) {
  assertExactKeys(result, REQUIRED_KEYS, "結果");
  if (!RESULT_STATUSES.includes(result.status)) fail(`未知 status: ${result.status}`);
  if (typeof result.summary !== "string" || !result.summary.trim()) fail("summary 不可為空");
  assertStringArray(result.changes, "changes");
  assertStringArray(result.warnings, "warnings");
  if (!Array.isArray(result.validation)) fail("validation 必須是陣列");
  for (const item of result.validation) {
    assertExactKeys(item, ["command", "status", "detail"], "validation 項目");
    if (typeof item.command !== "string" || typeof item.detail !== "string") fail("validation 文字欄位格式錯誤");
    if (!VALIDATION_STATUSES.includes(item.status)) fail(`未知 validation status: ${item.status}`);
  }
  if (!Array.isArray(result.commits)) fail("commits 必須是陣列");
  for (const item of result.commits) {
    assertExactKeys(item, ["hash", "message"], "commit 項目");
    if (typeof item.hash !== "string" || typeof item.message !== "string") fail("commit 欄位格式錯誤");
  }
  return result;
}

function validateTaskResult(result, mode = detectTaskResultMode(result)) {
  if (mode === "generic") {
    assertExactKeys(result, GENERIC_KEYS, "結果");
    if (!RESULT_STATUSES.includes(result.status)) fail(`未知 status: ${result.status}`);
    if (typeof result.output !== "string" || !result.output.trim()) fail("output 不可為空");
    return result;
  }
  return validateLegacyTaskResult(result);
}

function parseTaskResult(stdout, mode) {
  let result;
  try { result = JSON.parse(String(stdout || "")); }
  catch (error) { fail(`不是合法 JSON (${error.message})`); }
  return validateTaskResult(result, mode || detectTaskResultMode(result));
}

function queueStatus(resultStatus) {
  const mapping = { success: "done", failed: "failed", blocked: "blocked", partial: "review" };
  if (!mapping[resultStatus]) fail(`未知 status: ${resultStatus}`);
  return mapping[resultStatus];
}

module.exports = {
  GENERIC_TASK_RESULT_SCHEMA,
  LEGACY_TASK_RESULT_SCHEMA,
  TASK_RESULT_SCHEMA,
  detectTaskResultMode,
  parseTaskResult,
  queueStatus,
  schemaForMode,
  selectedTaskResultMode,
  validateTaskResult,
};
