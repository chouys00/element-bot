"use strict";
const path = require("path");
const { getTaskDef } = require("../taskDefs");
const { readJsonSafe, writeJsonAtomic } = require("../fsUtils");
const { parseTaskResult, queueStatus, validateTaskResult } = require("./taskResult");

const AI_OUTPUT_MAX = 8000;
const RESULT_FILE = "task-result.json";

function make(ops) {
  ops = ops || require("./ops");

  return {
    async prepare({ workDir, task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      const head = ops.gitHead ? ops.gitHead(src) : null;
      if (workDir && head) writeJsonAtomic(path.join(workDir, "base.json"), { head });
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
      if (typeof output === "string" && output.trim()) {
        emit({ ai_output: output.length > AI_OUTPUT_MAX ? output.slice(-AI_OUTPUT_MAX) : output });
      }
    },

    async verify({ shared }) {
      shared.verify = { ownedByTarget: true };
    },

    async summarize({ workDir, task, shared }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      const saved = shared.taskResult || (workDir ? readJsonSafe(path.join(workDir, RESULT_FILE), null) : null);
      if (!saved) throw new Error("找不到 Codex 結構化任務結果");
      const result = validateTaskResult(saved);
      return {
        ...result,
        queueStatus: queueStatus(result.status),
        produced: result.changes,
        openPath: src,
      };
    },
  };
}

module.exports = { make, RESULT_FILE };
