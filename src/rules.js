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
  // enabled:選填。false=停用此規則(不觸發)。缺省=啟用(向後相容,舊規則無此欄位視為啟用)。
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") throw new Error(`${where}.enabled 必須為布林`);
  if (rule.use_llm && (typeof rule.intent !== "string" || !rule.intent)) throw new Error(`${where}.intent 在 use_llm 時必填`);
  if (rule.extract !== undefined) {
    if (!Array.isArray(rule.extract) || !rule.extract.every((e) => typeof e === "string" && e)) {
      throw new Error(`${where}.extract 必須為非空字串陣列`);
    }
  }
  // rooms:選填。限定此規則只在這些房間生效;元素為 room_id(全域唯一)。缺省/空陣列=不觸發任何房間。
  // 注意:「啟用中的規則必須至少有一個房間」只在 saveRules 存檔時強制(見下),
  // validateRule/loadRules 不強制,避免舊檔或手改檔案讓整批規則無法載入。
  if (rule.rooms !== undefined) {
    if (!Array.isArray(rule.rooms) || !rule.rooms.every((r) => typeof r === "string" && r)) {
      throw new Error(`${where}.rooms 必須為非空字串陣列(room_id)`);
    }
  }
  // project_path / command:通用任務 skill-dispatch 用(專案絕對路徑 + 餵給 skill 的指令模板)。
  // 兩者選填(舊規則與內建任務不需要);提供時須為非空字串。是否必填交由執行期任務定義自行把關,
  // 避免驗證層耦合特定 task 名稱。
  if (rule.project_path !== undefined && (typeof rule.project_path !== "string" || !rule.project_path)) {
    throw new Error(`${where}.project_path 必須為非空字串`);
  }
  if (rule.command !== undefined && (typeof rule.command !== "string" || !rule.command)) {
    throw new Error(`${where}.command 必須為非空字串`);
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

// 把整批規則寫回檔案。先全條驗證(任一條不合法即丟錯、完全不寫),
// 再原子寫入(寫 .tmp 再 rename),避免 bot 的 fs.watch 讀到寫一半的檔。
function saveRules(rulesPath, rules) {
  if (!Array.isArray(rules)) throw new Error("規則必須是陣列");
  rules.forEach((r, i) => {
    validateRule(r, i);
    // 啟用中的規則必須至少指定一個房間:留空 = 不觸發任何房間(見 trigger.ruleMatchesRoom),
    // 幾乎必為誤設,故存檔時擋下。停用中的規則(enabled:false)可留空,反正本就不觸發。
    if (r.enabled !== false && (!Array.isArray(r.rooms) || r.rooms.length === 0)) {
      throw new Error(`rules[${i}] 啟用中的規則必須至少指定一個房間(rooms 不可為空)`);
    }
  });
  const tmp = rulesPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2), "utf8");
  fs.renameSync(tmp, rulesPath);
  return rules;
}

module.exports = { loadRules, validateRule, saveRules };
