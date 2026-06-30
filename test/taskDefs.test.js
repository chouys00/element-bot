"use strict";
const assert = require("assert");
const { getTaskDef } = require("../src/taskDefs");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

{
  const def = getTaskDef("i18n-skill");
  ok("找得到 i18n-skill", !!def);
  ok("有 sourceDir 函式", typeof def.sourceDir === "function");
  ok("有 prompt 函式", typeof def.prompt === "function");
  ok("有 verifyArgs 函式", typeof def.verifyArgs === "function");
  ok("prompt 含站點目錄指示", def.prompt({ params: { 站點: "siteA" } }).includes("當前工作目錄"));
}
{
  let threw = false;
  try { getTaskDef("不存在"); } catch (_) { threw = true; }
  ok("查無定義丟錯", threw);
}
{
  let threw = false;
  try { getTaskDef("i18n-skill").sourceDir({ params: { 站點: "../evil" } }); } catch (_) { threw = true; }
  ok("站點逸出 FTL_ROOT 丟錯", threw);
}
{
  const def = getTaskDef("demo-skill");
  ok("找得到 demo-skill", !!def);
  ok("demo-skill 有 prompt 函式", typeof def.prompt === "function");
  ok("demo-skill prompt 指向 SKILL.md", def.prompt({ source: { body: "把背景改成紅色" } }).includes("SKILL.md"));
  ok("demo-skill prompt 帶入聊天指令", def.prompt({ source: { body: "把背景改成紅色" } }).includes("把背景改成紅色"));
  ok("demo-skill 不跑 verify(verifyArgs null)", def.verifyArgs == null);
  ok("demo-skill 預設專案 sample-app", def.sourceDir({ params: {} }).endsWith("sample-app"));
  let threw = false;
  try { def.sourceDir({ params: { 專案: "../evil" } }); } catch (_) { threw = true; }
  ok("專案逸出 DEMO_ROOT 丟錯", threw);
}

console.log(`taskDefs.test.js: ${passed} 項通過 ✅`);
