"use strict";
const fs = require("fs");

// 驗證單一規則物件;不合法即丟出 Error。合法回傳 true。
function validateRule(rule, index) {
  const where = `rules[${index}]`;
  if (!rule || typeof rule !== "object") throw new Error(`${where} 不是物件`);
  if (typeof rule.name !== "string" || !rule.name) throw new Error(`${where}.name 必須為非空字串`);
  if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) throw new Error(`${where}.keywords 必須為非空陣列`);
  if (!rule.keywords.every((k) => typeof k === "string" && k)) throw new Error(`${where}.keywords 必須都是非空字串`);
  if (typeof rule.task !== "string" || !rule.task) throw new Error(`${where}.task 必須為非空字串`);
  if (typeof rule.use_llm !== "boolean") throw new Error(`${where}.use_llm 必須為布林`);
  if (rule.use_llm && (typeof rule.intent !== "string" || !rule.intent)) throw new Error(`${where}.intent 在 use_llm 時必填`);
  if (rule.extract !== undefined) {
    if (!Array.isArray(rule.extract) || !rule.extract.every((e) => typeof e === "string" && e)) {
      throw new Error(`${where}.extract 必須為非空字串陣列`);
    }
  }
  return true;
}

// 從檔案載入並逐條驗證規則,回傳規則陣列。
function loadRules(rulesPath) {
  const raw = fs.readFileSync(rulesPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("rules.json 最外層必須是陣列");
  parsed.forEach((r, i) => validateRule(r, i));
  return parsed;
}

module.exports = { loadRules, validateRule };
