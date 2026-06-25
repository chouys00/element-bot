"use strict";
// 用 Claude Haiku 4.5 判斷「命中關鍵字的訊息是否真的該觸發」並抽參數。
// schema / prompt / parse 為純函式以利測試;judge() 串接它們並呼叫 API。

// 依規則的 extract 欄位組出 structured-output 的 JSON schema。
// 注意:structured outputs 要求每個 object 都 additionalProperties:false,且 properties 全列入 required。
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

// 從 API 回傳的 content blocks 取出文字並解析成 {trigger, params}。
function parseJudgeResponse(content) {
  if (!Array.isArray(content)) throw new Error("回應 content 不是陣列");
  const textBlock = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  if (!textBlock) throw new Error("回應缺少 text block");
  const parsed = JSON.parse(textBlock.text);
  if (typeof parsed.trigger !== "boolean") throw new Error("回應缺少布林 trigger");
  return { trigger: parsed.trigger, params: parsed.params || {} };
}

// 實際呼叫 API。client 為 @anthropic-ai/sdk 的 Anthropic 實例。
async function judge(client, rule, message) {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserText(rule, message) }],
    output_config: { format: { type: "json_schema", schema: buildSchema(rule) } },
  });
  return parseJudgeResponse(resp.content);
}

module.exports = { buildSchema, buildUserText, parseJudgeResponse, judge, SYSTEM };
