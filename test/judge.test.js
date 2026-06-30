"use strict";
const assert = require("assert");
const { buildSchema, buildUserText, buildPrompt, parseJudgeText, judge, SYSTEM } = require("../src/judge");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}
function throws(name, fn) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  ok(name, threw);
}
async function rejects(name, fn) {
  let threw = false;
  try { await fn(); } catch (_) { threw = true; }
  ok(name, threw);
}

const schemaWith = buildSchema({ extract: ["環境", "服務名稱"] });
ok("schema 頂層含 trigger 與 params 必填", schemaWith.required.join() === "trigger,params");
ok("schema params 含 extract 欄位", schemaWith.properties.params.properties.環境.type === "string");
ok("schema params required 含全部 extract", schemaWith.properties.params.required.join() === "環境,服務名稱");

const schemaNone = buildSchema({});
ok("無 extract 時 params 無屬性", Object.keys(schemaNone.properties.params.properties).length === 0);

const text = buildUserText({ intent: "要部署才觸發", extract: ["環境"] }, "我要部署");
ok("prompt 含 intent", text.includes("要部署才觸發"));
ok("prompt 含訊息內容", text.includes("我要部署"));
ok("prompt 含抽欄位指示", text.includes("環境"));

// buildPrompt 把 SYSTEM、user text 與「只輸出 JSON」指示組成單一字串(給 claude CLI stdin)。
const prompt = buildPrompt({ intent: "要部署才觸發", extract: ["環境"] }, "我要部署");
ok("buildPrompt 含 SYSTEM", prompt.includes(SYSTEM));
ok("buildPrompt 含 user text", prompt.includes("要部署才觸發") && prompt.includes("我要部署"));
ok("buildPrompt 要求只輸出 JSON", prompt.includes("JSON"));

// parseJudgeText 從 CLI 純文字 stdout 解析 {trigger, params}。
const plain = parseJudgeText('{"trigger":true,"params":{"環境":"prod"}}');
ok("解析純 JSON trigger=true", plain.trigger === true);
ok("解析純 JSON params", plain.環境 === undefined && plain.params.環境 === "prod");

const fenced = parseJudgeText('這是判斷結果：\n```json\n{"trigger":false,"params":{}}\n```\n');
ok("解析被 markdown/文字包住的 JSON", fenced.trigger === false);

ok("無 params 時補空物件", parseJudgeText('{"trigger":true}').params && typeof parseJudgeText('{"trigger":true}').params === "object");

throws("找不到 JSON 丟錯", () => parseJudgeText("完全沒有 json 的文字"));
throws("trigger 非布林丟錯", () => parseJudgeText('{"params":{}}'));

(async () => {
  // judge 不再需要 client;用注入的 run 取代真正 spawn claude CLI。
  const res = await judge(
    { intent: "要部署才觸發", extract: ["環境"] },
    "幫我部署到 prod",
    { run: async () => '{"trigger":true,"params":{"環境":"prod"}}' }
  );
  ok("judge 回傳 trigger", res.trigger === true);
  ok("judge 回傳 params", res.params.環境 === "prod");

  // run 收到的就是 buildPrompt 的內容
  let seenPrompt = null;
  await judge(
    { intent: "要部署才觸發", extract: ["環境"] },
    "幫我部署到 prod",
    { run: async (p) => { seenPrompt = p; return '{"trigger":false,"params":{}}'; } }
  );
  ok("judge 把 buildPrompt 結果交給 run", seenPrompt === buildPrompt({ intent: "要部署才觸發", extract: ["環境"] }, "幫我部署到 prod"));

  // run 失敗(CLI 非零 exit / timeout)→ judge 丟出
  await rejects("run 失敗時 judge 丟出", () => judge(
    { intent: "x", extract: [] },
    "y",
    { run: async () => { throw new Error("claude CLI exit 1"); } }
  ));

  // run 回傳無法解析的內容 → judge 丟出
  await rejects("run 回傳非 JSON 時 judge 丟出", () => judge(
    { intent: "x", extract: [] },
    "y",
    { run: async () => "看不懂的輸出" }
  ));

  console.log(`judge.test.js: ${passed} 項通過 ✅`);
})();
