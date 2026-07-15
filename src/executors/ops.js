"use strict";
const { spawnSync } = require("child_process");
const { runCodex: invokeCodex } = require("../codexRunner");
const { schemaForMode, selectedTaskResultMode } = require("./taskResult");

// 來源須在 git 控制下且無未提交改動(改檔任務的安全網)。
function gitClean(srcDir) {
  const r = spawnSync("git", ["status", "--porcelain", "."], { cwd: srcDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("來源不在 git 控制下,缺安全網:" + srcDir);
  if ((r.stdout || "").trim()) throw new Error("來源有未提交改動,請先 commit/還原:" + srcDir);
}

// 列出工作區相對 HEAD 的改動檔(porcelain),用來判斷目標任務是否真的改了專案。
function gitChanged(srcDir) {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: srcDir, encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error("無法讀取 git 狀態(來源不在 git 控制下?):" + srcDir);
  return (r.stdout || "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim()); // porcelain:前兩字元狀態 + 空格,其後為路徑
}

// 目前 HEAD 的 commit hash;無 commit / 非 git 回 null。
// prepare 記下起跑 HEAD,summarize 據此偵測目標流程是否自行 commit。
function gitHead(srcDir) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: srcDir, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

// baseHead 之後新增的 commit(短 hash + 標題)與這些 commit 動到的檔案。
function gitCommitsSince(srcDir, baseHead) {
  const log = spawnSync("git", ["log", "--format=%h %s", `${baseHead}..HEAD`], { cwd: srcDir, encoding: "utf8" });
  if (log.error || log.status !== 0) return { commits: [], files: [] };
  const commits = (log.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!commits.length) return { commits: [], files: [] };
  const diff = spawnSync("git", ["diff", "--name-only", baseHead, "HEAD"], { cwd: srcDir, encoding: "utf8" });
  const files = (diff.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return { commits, files };
}

// 執行期 provider 邊界只存在於 codexRunner；ops 不自行組合 CLI 參數。
function resultMode() {
  return selectedTaskResultMode();
}

function runCodex(prompt, projectDir, mode = resultMode()) {
  return invokeCodex(prompt, { mode: "execute", cwd: projectDir, outputSchema: schemaForMode(mode) });
}

// 跑 verify 腳本,從輸出解析 errors=/warnings=。
function runVerify(args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  if (r.error) throw r.error;
  const text = String(r.stdout || "") + "\n" + String(r.stderr || "");
  const m = text.match(/errors=(\d+),\s*warnings=(\d+)/);
  if (!m) throw new Error("verify 輸出格式錯誤,找不到 errors=/warnings= 行:\n" + text.slice(0, 300));
  return { errors: parseInt(m[1], 10), warnings: parseInt(m[2], 10) };
}

module.exports = { gitClean, gitChanged, gitHead, gitCommitsSince, resultMode, runCodex, runVerify };
