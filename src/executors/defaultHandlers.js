"use strict";
const fs = require("fs");
const path = require("path");
const { getTaskDef } = require("../taskDefs");

// 用注入的 ops 組出四個真實步驟處理器。ops 預設為真實副作用,測試可傳假的。
function make(ops) {
  ops = ops || require("./ops");

  function copyDirOf(workDir) { return path.join(workDir, "copy"); }

  return {
    async prepare({ workDir, task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      ops.gitClean(src);
      ops.copyTree(src, copyDirOf(workDir));
      emit({ step: "prepare", status: "run", note: "已建立隔離副本" });
    },

    async ai_run({ workDir, task, emit }) {
      const def = getTaskDef(task.task);
      const copyDir = copyDirOf(workDir);
      const artifacts = def.artifacts || [];
      const allExist = artifacts.length > 0 && artifacts.every((a) => fs.existsSync(path.join(copyDir, a)));
      if (allExist) { emit({ step: "ai_run", status: "run", note: "產物已存在,跳過(省額度)" }); return; }
      // 任務定義提供 run() → 執行本地動作(非 claude);否則走 claude。
      if (typeof def.run === "function") {
        emit({ step: "ai_run", status: "run", note: "執行本地動作(模擬改動)" });
        await def.run(copyDir, task);
        return;
      }
      ops.runClaude(def.prompt(task), copyDir);
    },

    async verify({ workDir, task, shared }) {
      const def = getTaskDef(task.task);
      if (!def.verifyArgs) { shared.verify = { errors: 0, warnings: 0 }; return; }
      shared.verify = ops.runVerify(def.verifyArgs(copyDirOf(workDir)));
    },

    async summarize({ workDir, task, shared }) {
      const def = getTaskDef(task.task);
      const copyDir = copyDirOf(workDir);
      const produced = (def.artifacts || []).filter((a) => fs.existsSync(path.join(copyDir, a)));
      if (!produced.length) return { status: "ERROR", message: "未產出任何產物", openPath: copyDir };
      const v = shared.verify || { errors: 0 };
      if (v.errors > 0) return { status: "NEEDS", summary: `產出但 verify 有缺:errors=${v.errors}`, produced, openPath: copyDir };
      return { status: "OK", summary: `產出 ${produced.join(", ")},verify errors=0`, needsReview: def.needsReview || [], produced, openPath: copyDir };
    },
  };
}

module.exports = { make };
