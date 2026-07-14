"use strict";
const path = require("path");
const { getTaskDef } = require("../taskDefs");
const { readJsonSafe, writeJsonAtomic } = require("../fsUtils");

// Codex 輸出進 NDJSON log 的截尾上限(保尾不保頭:結尾是結論/摘要,較有價值)。
const AI_OUTPUT_MAX = 8000;

// 用注入的 ops 組出四個真實步驟處理器(「直接改本體」模型)。ops 預設為真實副作用,測試可傳假的。
// element-bot 只做派發,不複製、不 commit:
//   prepare   - 唯讀檢查本體 git 乾淨(確保本次 diff 只含這次改動),並記下起跑 HEAD
//   ai_run    - 叫 Codex 進真實專案，依該專案自身設定執行，輸出進 log
//   verify    - 交由各專案自己的驗證腳本(可無 → 跳過)
//   summarize - 用 git 看本體改了哪些檔來判斷成敗;工作區沒改動時再比對 HEAD,
//               偵測 skill 違規自行 commit(否則會誤判成「未產生任何改動」)
function make(ops) {
  ops = ops || require("./ops");

  return {
    async prepare({ workDir, task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      ops.gitClean(src); // 唯讀安全檢查:本體須乾淨
      // 記下起跑 HEAD 供 summarize 比對;寫進 workDir 讓斷點續跑(prepare 被跳過)後仍讀得到。
      const head = ops.gitHead ? ops.gitHead(src) : null;
      if (workDir && head) writeJsonAtomic(path.join(workDir, "base.json"), { head });
      emit({ step: "prepare", status: "run", note: "本體 git 乾淨,直接在本體作業" });
    },

    async ai_run({ task, emit }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      emit({ step: "ai_run", status: "run", note: "派發 Codex 依目標專案自身設定執行" });
      const output = await ops.runCodex(def.prompt(task), src);
      if (typeof output === "string" && output.trim()) {
        emit({ ai_output: output.length > AI_OUTPUT_MAX ? output.slice(-AI_OUTPUT_MAX) : output });
      }
    },

    async verify({ task, shared }) {
      const def = getTaskDef(task.task);
      if (!def.verifyArgs) { shared.verify = { errors: 0, warnings: 0 }; return; }
      shared.verify = ops.runVerify(def.verifyArgs(def.sourceDir(task)));
    },

    async summarize({ workDir, task, shared }) {
      const def = getTaskDef(task.task);
      const src = def.sourceDir(task);
      const changed = ops.gitChanged(src); // 本體改了哪些檔
      if (changed.length) {
        const v = shared.verify || { errors: 0 };
        if (v.errors > 0) return { status: "NEEDS", summary: `已改動但 verify 有缺:errors=${v.errors}`, produced: changed, openPath: src };
        return { status: "OK", summary: `改動 ${changed.length} 個檔:${changed.join(", ")}`, needsReview: def.needsReview || [], produced: changed, openPath: src };
      }
      // 工作區乾淨:比對起跑 HEAD。目標專案流程可能依自身指示以 commit 收尾(正當),
      // 也可能是 headless agent 自作主張；無論何者都如實回報，不誤判成「沒做事」。
      const base = workDir ? readJsonSafe(path.join(workDir, "base.json"), null) : null;
      if (base && base.head && ops.gitHead && ops.gitCommitsSince) {
        const now = ops.gitHead(src);
        if (now && now !== base.head) {
          const { commits, files } = ops.gitCommitsSince(src, base.head);
          return {
            status: "OK",
            summary: `目標流程已將改動 commit(${commits.length} 筆:${commits.join(";")}),共 ${files.length} 個檔:${files.join(", ")}`,
            needsReview: ["改動已被 commit,請確認 commit 是目標專案 instructions 明確要求的(否則屬自作主張,必要時 git reset)", ...(def.needsReview || [])],
            produced: files,
            openPath: src,
          };
        }
      }
      return { status: "ERROR", message: "目標任務未對專案產生任何改動", openPath: src };
    },
  };
}

module.exports = { make };
