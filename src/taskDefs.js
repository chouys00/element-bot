"use strict";
const path = require("path");

// element-bot 只分派到規則指定的專案；目標專案自行決定 instructions、skills 與實作方式。
const DEFS = {
  "skill-dispatch": {
    sourceDir: (task) => {
      const projectPath = String((task && task.project_path) || "");
      if (!projectPath) throw new Error("skill-dispatch 缺 project_path（請在規則設定目標專案）");
      return path.resolve(projectPath);
    },
    prompt: (task, context = {}) => {
      const command = String((task && task.command) || "");
      const taskId = String(context.id || "");
      const targetBranch = String((task && task.target_branch) || "");
      const projectPath = DEFS["skill-dispatch"].sourceDir(task);
      if (!taskId) throw new Error("skill-dispatch 缺 Task-ID");
      if (!targetBranch) throw new Error("skill-dispatch 缺 target_branch");
      return [
        "這是已核准交由本次無人值守流程直接執行的專案任務。",
        "請依目標專案自己的 AGENTS.md、instructions、skills 與安全規則完成要求；element-bot 不介入專案工具體系。",
        "不得自行增加等待人類再次確認的步驟。若要求已經完成，請驗證現況後回報 success，不要重複修改。",
        `Task-ID：${taskId}`,
        `target_branch：${targetBranch}`,
        `project_path：${projectPath}`,
        "請直接在 project_path 讀取、修改與驗證檔案；不要建立、複製或掃描另一份任務工作區。",
        "目前分支與工作樹乾淨狀態已由 element-bot 在起跑前檢查；不得自行切換到其他分支。",
        "本次採 element-bot 自動派發的輕量執行模式。除非目標專案針對本任務明確要求，否則不要啟用或延伸全域通用開發流程，包括 TDD／紅燈測試、獨立審查、subagent 或 worktree。",
        "只做完成 command 所需的最小修改與必要驗證；不得為了通用流程新增測試檔，也不得執行與任務無直接關係的完整測試。",
        "若目標專案自己的 instructions 或 skills 明確要求測試或驗證，仍須遵守，以目標專案的明確要求為準。",
        "在 Dashboard 驗收前，不得執行 commit，也不得執行 push；請保留本任務修改供人工驗收。",
        "若無法安全完成，回報 blocked 並清楚說明原因，不得以提交或推送規避問題。",
        "command：" + command,
        "完成後依指定 schema 回報 status 與完整 output；output 必須包含實際處理結果與可供驗收的資訊。",
      ].join("\n");
    },
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

module.exports = { getTaskDef, taskNames };
