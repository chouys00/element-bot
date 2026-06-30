"use strict";
const { getTaskDef } = require("../taskDefs");

// 用注入的 ops 組出四個真實步驟處理器(「直接改本體」模型)。ops 預設為真實副作用,測試可傳假的。
// element-bot 只做派發,不複製、不 commit:
//   prepare   - 唯讀檢查本體 git 乾淨(確保本次 diff 只含這次改動)
//   ai_run    - 叫 claude 進真實專案、讀該專案的 SKILL.md 並執行(改本體,不 commit)
//   verify    - 交由各專案自己的驗證腳本(可無 → 跳過)
//   summarize - 用 git 看本體改了哪些檔來判斷成敗
function make(ops) {
  ops = ops || require("./ops");

  return {
    async prepare({ task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      ops.gitClean(src); // 唯讀安全檢查:本體須乾淨
      emit({ step: "prepare", status: "run", note: "本體 git 乾淨,直接在本體作業" });
    },

    async ai_run({ task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      emit({ step: "ai_run", status: "run", note: "派發 claude 讀專案 SKILL.md 並執行" });
      // 把 claude 帶進真實專案(cwd=src),由 prompt 指示它讀該專案的 SKILL.md 並執行。
      ops.runClaude(def.prompt(task), src);
    },

    async verify({ task, shared }) {
      const def = getTaskDef(task.task);
      if (!def.verifyArgs) { shared.verify = { errors: 0, warnings: 0 }; return; }
      shared.verify = ops.runVerify(def.verifyArgs(def.sourceDir(task)));
    },

    async summarize({ task, shared }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      const changed = ops.gitChanged(src); // 本體改了哪些檔
      if (!changed.length) return { status: "ERROR", message: "SKILL 未對本體產生任何改動", openPath: src };
      const v = shared.verify || { errors: 0 };
      if (v.errors > 0) return { status: "NEEDS", summary: `已改動但 verify 有缺:errors=${v.errors}`, produced: changed, openPath: src };
      return { status: "OK", summary: `改動 ${changed.length} 個檔:${changed.join(", ")}`, needsReview: def.needsReview || [], produced: changed, openPath: src };
    },
  };
}

module.exports = { make };
