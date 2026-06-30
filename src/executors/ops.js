"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");

// 來源須在 git 控制下且無未提交改動(改檔任務的安全網)。
function gitClean(srcDir) {
  const r = spawnSync("git", ["status", "--porcelain", "."], { cwd: srcDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("來源不在 git 控制下,缺安全網:" + srcDir);
  if ((r.stdout || "").trim()) throw new Error("來源有未提交改動,請先 commit/還原:" + srcDir);
}

// 列出工作區相對 HEAD 的改動檔(porcelain),用來判斷 SKILL 是否真的改了本體。
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

// 在專案目錄(本體)內跑 headless claude;非零 exit 丟錯。
function runClaude(prompt, projectDir) {
  const r = spawnSync("claude", ["--dangerously-skip-permissions", "-p"], {
    input: prompt,
    cwd: projectDir, encoding: "utf8",
    shell: process.platform === "win32",
    timeout: parseInt(process.env.AI_TIMEOUT_MS || "1800000", 10),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error("claude 失敗:" + String(r.stderr || "").slice(0, 200));
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

module.exports = { gitClean, gitChanged, runClaude, runVerify };
