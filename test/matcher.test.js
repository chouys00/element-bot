"use strict";
const assert = require("assert");
const { matchRules } = require("../src/matcher");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const rules = [
  { name: "deploy", keywords: ["部署", "deploy"], task: "t1", use_llm: false },
  { name: "report", keywords: ["週報"], task: "t2", use_llm: false },
];

ok("命中中文關鍵字", matchRules("我要部署一下", rules).map((r) => r.name).join() === "deploy");
ok("命中英文關鍵字(大小寫不敏感)", matchRules("please DEPLOY now", rules).map((r) => r.name).join() === "deploy");
ok("未命中回空陣列", matchRules("今天天氣很好", rules).length === 0);
ok("一則可命中多條", matchRules("部署完發週報", rules).length === 2);
ok("body 非字串回空陣列", matchRules(null, rules).length === 0);
ok("rules 非陣列回空陣列", matchRules("部署", null).length === 0);

console.log(`matcher.test.js: ${passed} 項通過 ✅`);
