"use strict";
const path = require("path");

// element-bot 只定義「到哪個專案、交付什麼指令」，不判斷目標專案的 skill 體系。
// sourceDir(task) -> Codex 的工作目錄
// prompt(task)    -> 交給 Codex 的任務與安全邊界
// verifyArgs(src) -> 選填的外部驗證指令；目前通用任務不使用
const DEFS = {
  // 正式通用分派：目標專案如何解讀 instructions/skills 完全由該專案與 Codex 決定。
  "skill-dispatch": {
    sourceDir: (task) => {
      const projectPath = String((task && task.project_path) || "");
      if (!projectPath) throw new Error("skill-dispatch 缺 project_path(規則須指定專案絕對路徑)");
      return path.resolve(projectPath);
    },
    prompt: (task) => {
      const command = String((task && task.command) || "");
      return [
        "你正在規則指定的目標專案中執行任務。",
        "請把下方 command 視為使用者直接在此專案提出的要求。",
        "依此專案自身的 AGENTS.md、instructions 與 skills 完整執行；element-bot 不介入專案如何修改、驗證或提交。",
        "command：" + command,
        "完成後依指定 schema 回報實際結果與證據；不得在回報中包含 token、密碼或其他秘密內容。",
      ].join("\n");
    },
    verifyArgs: null,
    needsReview: ["確認目標專案流程與執行結果符合預期", "正式套用前再次確認"],
  },
};

function getTaskDef(name) {
  const def = DEFS[name];
  if (!def) throw new Error("未知任務定義:" + name);
  return def;
}

function taskNames() {
  return Object.keys(DEFS);
}

// element-bot 不維護外部專案白名單；外部目標只由 projectCheck 與 executor 做安全檢查。
const PROJECT_ROOTS = [];

module.exports = { getTaskDef, PROJECT_ROOTS, taskNames };
