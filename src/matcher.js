"use strict";
// 純函式:在訊息內文中比對規則關鍵字(大小寫不敏感、子字串比對)。
// 回傳所有命中的規則物件陣列(可能 0~多條)。
function matchRules(body, rules) {
  if (typeof body !== "string" || !Array.isArray(rules)) return [];
  const hay = body.toLowerCase();
  return rules.filter(
    (rule) =>
      Array.isArray(rule.keywords) &&
      rule.keywords.some((kw) => typeof kw === "string" && hay.includes(kw.toLowerCase()))
  );
}

module.exports = { matchRules };
