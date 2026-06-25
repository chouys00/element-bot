"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadRules, validateRule } = require("../src/rules");

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

const good = { name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: false };
ok("合法規則通過驗證", validateRule(good, 0) === true);
ok("use_llm:true 且有 intent 通過", validateRule({ ...good, use_llm: true, intent: "x" }, 0) === true);

throws("name 空字串被拒", () => validateRule({ ...good, name: "" }, 0));
throws("keywords 空陣列被拒", () => validateRule({ ...good, keywords: [] }, 0));
throws("task 缺少被拒", () => validateRule({ name: "a", keywords: ["x"], use_llm: false }, 0));
throws("use_llm 非布林被拒", () => validateRule({ ...good, use_llm: "yes" }, 0));
throws("use_llm:true 但缺 intent 被拒", () => validateRule({ ...good, use_llm: true }, 0));
throws("extract 非字串陣列被拒", () => validateRule({ ...good, extract: [1, 2] }, 0));

const tmp = path.join(os.tmpdir(), `rules-test-${Date.now()}.json`);
fs.writeFileSync(tmp, JSON.stringify([good]), "utf8");
const loaded = loadRules(tmp);
ok("loadRules 回傳陣列", Array.isArray(loaded) && loaded.length === 1);
ok("loadRules 內容正確", loaded[0].name === "deploy");
fs.unlinkSync(tmp);

const tmpBad = path.join(os.tmpdir(), `rules-bad-${Date.now()}.json`);
fs.writeFileSync(tmpBad, JSON.stringify({ not: "array" }), "utf8");
throws("loadRules 對非陣列丟錯", () => loadRules(tmpBad));
fs.unlinkSync(tmpBad);

console.log(`rules.test.js: ${passed} 項通過 ✅`);
