"use strict";
const assert = require("assert");
const path = require("path");
const taskDefs = require("../src/taskDefs");
const { getTaskDef, taskNames } = taskDefs;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

assert.deepStrictEqual(Object.keys(taskDefs).sort(), ["getTaskDef", "taskNames"], "taskDefs 不維護開啟專案白名單");
passed++;

{
  let threw = false;
  try { getTaskDef("i18n-skill"); } catch (_) { threw = true; }
  ok("i18n-skill 已從通用分派器移除", threw);
}
{
  let threw = false;
  try { getTaskDef("demo-skill"); } catch (_) { threw = true; }
  ok("demo-skill 已從正式任務清單移除", threw);
}
{
  let threw = false;
  try { getTaskDef("不存在"); } catch (_) { threw = true; }
  ok("查無定義丟錯", threw);
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
  const context = { id: "task-123", workDir: "D:\\queue\\work\\task-123" };
  ok("skill-dispatch prompt 帶入指令", def.prompt({ command: "/i18n pages/activity", target_branch: "main" }, context).includes("/i18n pages/activity"));
  const prompt = def.prompt({ command: "https://zentao.example/bug-view-1.html", target_branch: "release/x" }, context);
  ok("prompt 將 command 視為已核准要求", prompt.includes("已核准交由本次流程直接執行"));
  ok("prompt 要求依專案 instructions 與 skills 執行", prompt.includes("instructions") && prompt.includes("skills"));
  ok("prompt 要求結構化回報", prompt.includes("指定 schema"));
  for (const forbidden of [".claude/skills", ".agents/skills", ".cursor/skills"]) {
    ok(`skill-dispatch prompt 不指定 ${forbidden}`, !def.prompt({ command: "啟動", target_branch: "main" }, context).includes(forbidden));
  }
  for (const forbidden of ["不得讀寫工作目錄之外", "預設不 commit", "絕不自作主張"]) {
    ok(`prompt 不含派發器政策: ${forbidden}`, !prompt.includes(forbidden));
  }
  assert.deepStrictEqual(Object.keys(def).sort(), ["prompt", "sourceDir"], "task definition 不保留 legacy 欄位");
  passed++;

  const genericPrompt = def.prompt({ command: "處理這項要求", target_branch: "main" }, context);
  ok("generic 任務已核准", genericPrompt.includes("已核准") && genericPrompt.includes("無人值守"));
  ok("不得自行等待確認", genericPrompt.includes("不得自行增加") && genericPrompt.includes("再次確認"));
  ok("已完成回報成功且不重做", genericPrompt.includes("已經完成") && genericPrompt.includes("success") && genericPrompt.includes("不重複"));
  ok("Dashboard 驗收前禁止 commit/push", genericPrompt.includes("Dashboard 驗收") && genericPrompt.includes("不得執行 commit") && genericPrompt.includes("不得執行 push"));
  ok("prompt 帶 Task-ID 與目標分支", prompt.includes("task-123") && prompt.includes("release/x"));
  ok("prompt 要求 Task 專屬 worktree", prompt.includes(path.join(context.workDir, "workspace")) && prompt.includes("git worktree") && prompt.includes("--detach"));
  ok("prompt 禁止在共用 project_path 留下修改", prompt.includes("共用專案工作目錄") && prompt.includes("不得留下任何修改"));
  ok("沒有無關任務類型假設", !/Jenkins|客服|聊天室/.test(genericPrompt));
}

{
  const names = taskNames();
  ok("taskNames 回傳陣列", Array.isArray(names));
  ok("taskNames 不含 demo-skill", !names.includes("demo-skill"));
  ok("taskNames 不含 i18n-skill", !names.includes("i18n-skill"));
  ok("taskNames 含 skill-dispatch", names.includes("skill-dispatch"));
  ok("正式任務只保留 skill-dispatch", names.length === 1);
}

console.log(`taskDefs.test.js: ${passed} 項通過 ✅`);
