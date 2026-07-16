"use strict";
const path = require("path");
const { getTaskDef } = require("../taskDefs");
const { readJsonSafe, writeJsonAtomic } = require("../fsUtils");
const { parseTaskResult, queueStatus, validateTaskResult } = require("./taskResult");

const RESULT_FILE = "task-result.json";

function make(ops) {
  ops = ops || require("./ops");

  return {
    async prepare({ task, emit }) {
      const def = getTaskDef(task.task);
      def.sourceDir(task);
      emit({ step: "prepare", status: "run", note: "目標專案已確認，流程與工作區狀態交由專案自身管理" });
    },

    async ai_run({ workDir, task, emit, shared }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      emit({ step: "ai_run", status: "run", note: "派發 Codex 依目標專案自身設定獨立執行" });
      const output = await ops.runCodex(def.prompt(task), src);
      const result = parseTaskResult(output);
      if (workDir) writeJsonAtomic(path.join(workDir, RESULT_FILE), result);
      if (shared) shared.taskResult = result;
      if (result.output.trim()) {
        emit({ ai_output: result.output });
      }
    },

    async verify({ shared }) {
      shared.verify = { ownedByTarget: true };
    },

    async summarize({ workDir, shared }) {
      const saved = shared.taskResult || (workDir ? readJsonSafe(path.join(workDir, RESULT_FILE), null) : null);
      if (!saved) throw new Error("找不到 Codex 結構化任務結果");
      const result = validateTaskResult(saved);
      return {
        ...result,
        queueStatus: queueStatus(result.status),
        produced: Array.isArray(result.changes) ? result.changes : [],
      };
    },
  };
}

module.exports = { make };
