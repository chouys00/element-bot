"use strict";
const assert = require("assert");
const { getTaskDef, taskNames } = require("../src/taskDefs");

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

// 通用任務 skill-dispatch:路徑與指令都由 task 帶入(規則資料),定義本身固定。
{
  const def = getTaskDef("skill-dispatch");
  ok("找得到 skill-dispatch", !!def);
  ok("skill-dispatch sourceDir 用 task.project_path", def.sourceDir({ project_path: "D:\\GB\\GBH5" }).includes("GBH5"));
  {
    let threw = false;
    try { def.sourceDir({}); } catch (_) { threw = true; }
    ok("skill-dispatch 缺 project_path 丟錯", threw);
  }
  ok("skill-dispatch prompt 帶入指令", def.prompt({ command: "/i18n pages/activity" }).includes("/i18n pages/activity"));
  ok("skill-dispatch prompt 提及用 skill 識別", def.prompt({ command: "啟動" }).includes("skill"));
  ok("skill-dispatch prompt 含安全紅線", def.prompt({ command: "啟動" }).includes("安全紅線"));
  ok("skill-dispatch prompt 預設不 commit(依 skill 文件指示)", def.prompt({ command: "啟動" }).includes("預設不 commit"));
  ok("skill-dispatch prompt 禁止自作主張 commit", def.prompt({ command: "啟動" }).includes("絕不自作主張"));
  ok("skill-dispatch 不跑 verify(verifyArgs null)", def.verifyArgs == null);
}

// 兩個「直接改本體」任務的 prompt:commit 與否由專案 skill 文件決定,
// 但 headless claude 不得自作主張(沒被要求就 commit 曾導致成敗誤判,見 defaultHandlers.summarize)。
ok("demo-skill prompt 預設不 commit(依 SKILL.md 指示)", getTaskDef("demo-skill").prompt({ source: { body: "x" } }).includes("預設不 commit"));

{
  const names = taskNames();
  ok("taskNames 回傳陣列", Array.isArray(names));
  ok("taskNames 含 demo-skill", names.includes("demo-skill"));
  ok("taskNames 含 i18n-skill", names.includes("i18n-skill"));
  ok("taskNames 含 skill-dispatch", names.includes("skill-dispatch"));
}

console.log(`taskDefs.test.js: ${passed} 項通過 ✅`);
