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
  ok("有 artifacts 陣列", Array.isArray(def.artifacts));
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

console.log(`taskDefs.test.js: ${passed} 項通過 ✅`);
