"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadRules, validateRule, saveRules } = require("../src/rules");

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

ok("enabled:false 通過驗證", validateRule({ ...good, enabled: false }, 0) === true);
ok("enabled:true 通過驗證", validateRule({ ...good, enabled: true }, 0) === true);
ok("enabled 省略通過", validateRule(good, 0) === true);
throws("enabled 非布林被拒", () => validateRule({ ...good, enabled: "yes" }, 0));

ok("rooms 字串陣列通過", validateRule({ ...good, rooms: ["!a:s", "!b:s"] }, 0) === true);
ok("rooms 省略通過", validateRule(good, 0) === true);
throws("rooms 非字串陣列被拒", () => validateRule({ ...good, rooms: [1] }, 0));
throws("rooms 含空字串被拒", () => validateRule({ ...good, rooms: ["ok", ""] }, 0));

// project_path / command:通用任務 skill-dispatch 用。選填,提供則須為非空字串。
ok("project_path 字串通過", validateRule({ ...good, project_path: "D:\\GB\\GBH5" }, 0) === true);
ok("command 字串通過", validateRule({ ...good, command: "/i18n {路徑}" }, 0) === true);
ok("project_path/command 省略通過", validateRule(good, 0) === true);
throws("project_path 空字串被拒", () => validateRule({ ...good, project_path: "" }, 0));
throws("command 空字串被拒", () => validateRule({ ...good, command: "" }, 0));
throws("project_path 非字串被拒", () => validateRule({ ...good, project_path: 123 }, 0));

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

// saveRules:全條合法才原子寫;有壞規則整批拒、檔案不動。
// 註:啟用中規則存檔時強制要有房間,故 saveRules 測試一律帶 rooms。
const goodR = { ...good, rooms: ["!a:s"] };
const tmpSave = path.join(os.tmpdir(), `rules-save-${Date.now()}.json`);
saveRules(tmpSave, [goodR, { ...goodR, name: "second" }]);
ok("saveRules 寫入後可被 loadRules 讀回", loadRules(tmpSave).length === 2);
ok("saveRules 內容正確(縮排 JSON)", loadRules(tmpSave)[1].name === "second");

fs.writeFileSync(tmpSave, JSON.stringify([goodR]), "utf8"); // 先放一筆已知內容
throws("saveRules 遇壞規則丟錯", () => saveRules(tmpSave, [goodR, { name: "" }]));
ok("saveRules 失敗不改動原檔(整批拒)", loadRules(tmpSave).length === 1);
ok("saveRules 失敗不留 .tmp 殘檔", !fs.existsSync(tmpSave + ".tmp"));
throws("saveRules 對非陣列丟錯", () => saveRules(tmpSave, { not: "array" }));

// saveRules:啟用中的規則必須至少指定一個房間(留空=不觸發,幾乎必為誤設);停用規則可留空。
fs.writeFileSync(tmpSave, JSON.stringify([{ ...good, rooms: ["!a:s"] }]), "utf8");
throws("saveRules 擋『啟用中卻無 rooms』", () => saveRules(tmpSave, [good])); // good 無 rooms 且預設啟用
throws("saveRules 擋『啟用中 rooms 為空陣列』", () => saveRules(tmpSave, [{ ...good, rooms: [] }]));
ok("saveRules 失敗(缺房間)不改動原檔", loadRules(tmpSave)[0].rooms[0] === "!a:s");
saveRules(tmpSave, [{ ...good, rooms: ["!a:s"] }]);
ok("saveRules 啟用中且有房間 → 成功", loadRules(tmpSave).length === 1);
saveRules(tmpSave, [{ ...good, enabled: false }]);
ok("saveRules 停用規則可無房間", loadRules(tmpSave)[0].enabled === false);
fs.unlinkSync(tmpSave);

console.log(`rules.test.js: ${passed} 項通過 ✅`);
