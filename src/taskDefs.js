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
        "你是自動化執行代理，工作目錄是這次任務唯一允許修改的目標專案。",
        "請把下方 command 視為使用者在目標專案中提出的要求。",
        "依目標專案自身的 instructions 與可用 skills 判斷並執行正確流程；element-bot 不指定其位置或工具體系。",
        "command：" + command,
        "安全紅線：不得讀寫工作目錄之外的檔案，不得修改其他專案。",
        "版本控制：只有目標專案 instructions 或採用的 skill 明確要求時才能 commit；否則預設不 commit。絕不自作主張 push、tag 或 reset。",
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
