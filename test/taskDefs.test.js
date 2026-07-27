"use strict";
const assert = require("assert");
const path = require("path");
const taskDefs = require("../src/taskDefs");
const { getTaskDef, taskNames } = taskDefs;

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; }

assert.deepStrictEqual(Object.keys(taskDefs).sort(), ["getTaskDef", "taskNames"], "taskDefs 不維護開啟專案白名單");
passed++;

for (const removed of ["i18n-skill", "demo-skill", "不存在"]) {
  let threw = false;
  try { getTaskDef(removed); } catch (_) { threw = true; }
  ok(`${removed} 不在正式任務清單`, threw);
}

{
  const def = getTaskDef("skill-dispatch");
  const projectPath = "D:\\GB\\GBH5";
  const baseTask = {
    project_path: projectPath,
    target_branch: "main",
    command: "處理這項要求",
  };
  const context = { id: "task-123", workDir: "D:\\queue\\work\\task-123" };

  ok("找得到 skill-dispatch", !!def);
  ok("skill-dispatch sourceDir 用 task.project_path", def.sourceDir(baseTask).includes("GBH5"));
  {
    let threw = false;
    try { def.sourceDir({}); } catch (_) { threw = true; }
    ok("skill-dispatch 缺 project_path 丟錯", threw);
  }

  ok(
    "skill-dispatch prompt 帶入指令",
    def.prompt({ ...baseTask, command: "/i18n pages/activity" }, context).includes("/i18n pages/activity"),
  );
  const prompt = def.prompt({
    ...baseTask,
    command: "https://zentao.example/bug-view-1.html",
    target_branch: "release/x",
  }, context);
  ok("prompt 將 command 視為已核准要求", prompt.includes("已核准交由本次"));
  ok("prompt 要求依專案 instructions 與 skills 執行", prompt.includes("instructions") && prompt.includes("skills"));
  ok("prompt 要求結構化回報", prompt.includes("指定 schema"));
  for (const forbidden of [".claude/skills", ".agents/skills", ".cursor/skills"]) {
    ok(`skill-dispatch prompt 不指定 ${forbidden}`, !prompt.includes(forbidden));
  }
  for (const forbidden of ["不得讀寫工作目錄之外", "預設不 commit", "絕不自作主張"]) {
    ok(`prompt 不含派發器政策: ${forbidden}`, !prompt.includes(forbidden));
  }
  assert.deepStrictEqual(Object.keys(def).sort(), ["prompt", "sourceDir"], "task definition 不保留舊欄位");
  passed++;

  const genericPrompt = def.prompt(baseTask, context);
  ok("generic 任務已核准", genericPrompt.includes("已核准") && genericPrompt.includes("無人值守"));
  ok("不得自行等待確認", genericPrompt.includes("不得自行增加") && genericPrompt.includes("再次確認"));
  ok("已完成回報成功且不重做", genericPrompt.includes("已經完成") && genericPrompt.includes("success") && genericPrompt.includes("不要重複"));
  ok("Dashboard 驗收前禁止 commit/push", genericPrompt.includes("Dashboard 驗收") && genericPrompt.includes("不得執行 commit") && genericPrompt.includes("不得執行 push"));
  ok("prompt 帶 Task-ID 與目標分支", prompt.includes("task-123") && prompt.includes("release/x"));
  ok("prompt 帶直接專案絕對路徑", prompt.includes(path.resolve(projectPath)) && prompt.includes("直接在 project_path"));
  ok("prompt 不要求建立 worktree", !prompt.includes("git worktree") && !prompt.includes("Task 專屬工作區"));
  ok(
    "自動派發採輕量流程且不啟用全域通用開發流程",
    prompt.includes("輕量執行") &&
      prompt.includes("全域通用開發流程") &&
      prompt.includes("TDD") &&
      prompt.includes("獨立審查") &&
      prompt.includes("subagent"),
  );
  ok(
    "輕量流程只做必要修改與驗證",
    prompt.includes("最小修改") &&
      prompt.includes("必要驗證") &&
      prompt.includes("不得為了通用流程新增測試檔"),
  );
  ok(
    "目標專案明確要求的測試仍優先",
    prompt.includes("目標專案") &&
      prompt.includes("明確要求測試或驗證") &&
      prompt.includes("仍須遵守"),
  );
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
