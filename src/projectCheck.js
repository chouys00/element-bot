"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");

// 檢查 skill-dispatch 的目標專案路徑健康度(供試跑的「專案健檢」用,零 AI 成本)。
// 回報而非丟錯(與 ops.gitClean 的「丟錯守門」不同用途):
//   { exists, is_git, clean, detail }
// existsFn / runGit 可注入以利測試。
function projectCheck(projectPath, opts = {}) {
  const p = String(projectPath || "");
  if (!p) return { exists: false, is_git: false, clean: false, detail: "未指定專案路徑" };
  const existsFn = opts.existsFn || ((x) => fs.existsSync(x));
  if (!existsFn(p)) return { exists: false, is_git: false, clean: false, detail: "路徑不存在" };
  const runGit = opts.runGit || ((dir) => spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }));
  const r = runGit(p);
  if (!r || r.status !== 0) return { exists: true, is_git: false, clean: false, detail: "不是 git 倉庫(缺派發安全網)" };
  const dirty = String(r.stdout || "").trim();
  if (dirty) return { exists: true, is_git: true, clean: false, detail: "有未提交改動,派發前需先 commit/還原" };
  return { exists: true, is_git: true, clean: true, detail: "存在、git 乾淨" };
}

module.exports = { projectCheck };
