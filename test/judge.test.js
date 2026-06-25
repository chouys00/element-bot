"use strict";
const assert = require("assert");
const { buildSchema, buildUserText, parseJudgeResponse } = require("../src/judge");

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

const okResp = parseJudgeResponse([{ type: "text", text: '{"trigger":true,"params":{"環境":"prod"}}' }]);
ok("解析 trigger=true", okResp.trigger === true);
ok("解析 params", okResp.params.環境 === "prod");

throws("缺 text block 丟錯", () => parseJudgeResponse([{ type: "image" }]));
throws("trigger 非布林丟錯", () => parseJudgeResponse([{ type: "text", text: '{"params":{}}' }]));

console.log(`judge.test.js: ${passed} 項通過 ✅`);
