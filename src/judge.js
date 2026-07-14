"use strict";
// 使用 Codex CLI 判斷「命中關鍵字的訊息是否真的該觸發」並抽取參數。
// schema / prompt / parse 維持純函式；所有 CLI 細節集中在 codexRunner。
const { runCodex } = require("./codexRunner");

// 依規則的 extract 欄位組出回傳 JSON 的 schema。
// 結構化輸出的 schema 仍嵌進 prompt,讓模型知道要回傳的形狀。
function buildSchema(rule) {
  const extract = Array.isArray(rule.extract) ? rule.extract : [];
  const paramProps = {};
  for (const field of extract) paramProps[field] = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      trigger: { type: "boolean" },
      params: {
        type: "object",
        additionalProperties: false,
        properties: paramProps,
        required: extract.slice(),
      },
    },
    required: ["trigger", "params"],
  };
}

// 組出給模型的 user 文字。
function buildUserText(rule, message) {
  const extract = Array.isArray(rule.extract) ? rule.extract : [];
  const extractLine = extract.length
    ? `若 trigger=true,從訊息抽出這些欄位(找不到就填空字串):${extract.join("、")}。`
    : "不需要抽任何欄位,params 回傳空物件 {}。";
  return [
    `觸發條件(intent):${rule.intent}`,
    `訊息內容:「${message}」`,
    "判斷這則訊息是否符合上述觸發條件。符合 trigger=true,否則 trigger=false。",
    extractLine,
  ].join("\n");
}

const SYSTEM =
  "你是訊息觸發判斷器。只依使用者提供的觸發條件,判斷訊息是否該觸發,並依指示抽出參數。只輸出符合 schema 的 JSON,不要多餘文字。";

// 把 SYSTEM、user 文字、schema 與「只輸出 JSON」指示組成單一字串,餵給 claude CLI 的 stdin。
function buildPrompt(rule, message) {
  return [
    SYSTEM,
    "",
    buildUserText(rule, message),
    "",
    "請只輸出符合以下 JSON schema 的單一 JSON 物件,不要 markdown 圍籬、不要任何說明文字:",
    JSON.stringify(buildSchema(rule)),
  ].join("\n");
}

// 從 CLI 純文字 stdout 解析出 {trigger, params}。
// 模型理應只輸出 JSON,但仍容錯:先試整段 parse,失敗則抓出第一個 {...} 區塊。
function parseJudgeText(text) {
  if (typeof text !== "string") throw new Error("CLI 輸出不是字串");
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch (_) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("CLI 輸出找不到 JSON");
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (typeof parsed.trigger !== "boolean") throw new Error("回應缺少布林 trigger");
  return { trigger: parsed.trigger, params: parsed.params || {} };
}

// 串接：組 prompt → 跑 Codex CLI → 解析。opts.run 可注入替代執行器以利測試。
// opts.retries(預設 1):CLI 偶發 timeout / 非零 exit / 輸出不合 schema 時重試一次,
// 降低「同一句話間歇性沒觸發」;仍失敗才丟錯(由呼叫端記錄)。
async function judge(rule, message, opts = {}) {
  const run = opts.run || runCodex;
  const retries = opts.retries != null ? opts.retries : 1;
  const prompt = buildPrompt(rule, message);
  const { run: _run, retries: _retries, ...runnerOptions } = opts;
  const runOptions = {
    ...runnerOptions,
    mode: "judge",
    timeoutMs: opts.timeoutMs || parseInt(process.env.JUDGE_TIMEOUT_MS || "120000", 10),
    outputSchema: buildSchema(rule),
  };
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return parseJudgeText(await run(prompt, runOptions));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = {
  buildSchema,
  buildUserText,
  buildPrompt,
  parseJudgeText,
  judge,
  SYSTEM,
};
