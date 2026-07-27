"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let checkProjectGit;
try {
  ({ checkProjectGit } = require("../src/projectGitGate"));
} catch (_) {}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(" ")} 失敗`);
  return String(result.stdout || "").trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-git-gate-"));
const repo = path.join(root, "repo");

(async () => {
  try {
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.name", "element-bot test"], repo);
    git(["config", "user.email", "element-bot-test@example.invalid"], repo);
    fs.writeFileSync(path.join(repo, "baseline.txt"), "baseline\n", "utf8");
    git(["add", "baseline.txt"], repo);
    git(["commit", "-q", "-m", "test: baseline"], repo);

    assert.strictEqual(typeof checkProjectGit, "function", "應提供唯讀 Git 起跑閘門");
    const result = await checkProjectGit({ project_path: repo, target_branch: "main" });
    assert.deepStrictEqual(result, {
      status: "ready",
      projectPath: path.resolve(repo),
      branch: "main",
    });

    fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf8");
    const dirty = await checkProjectGit({ project_path: repo, target_branch: "main" });
    assert.strictEqual(dirty.status, "waiting");
    assert.match(dirty.reason, /未提交變更/);
    assert.strictEqual(dirty.branch, "main");
    fs.rmSync(path.join(repo, "dirty.txt"));

    git(["checkout", "-q", "-b", "feature"], repo);
    const wrongBranch = await checkProjectGit({ project_path: repo, target_branch: "main" });
    assert.strictEqual(wrongBranch.status, "waiting");
    assert.match(wrongBranch.reason, /feature.*main/);
    git(["checkout", "-q", "main"], repo);

    git(["checkout", "-q", "--detach"], repo);
    const detached = await checkProjectGit({ project_path: repo, target_branch: "main" });
    assert.strictEqual(detached.status, "waiting");
    assert.match(detached.reason, /detached HEAD.*main/);
    git(["checkout", "-q", "main"], repo);

    const missing = await checkProjectGit({ project_path: path.join(root, "missing"), target_branch: "main" });
    assert.strictEqual(missing.status, "blocked");
    assert.match(missing.reason, /不存在/);

    const notDirectory = path.join(root, "file.txt");
    fs.writeFileSync(notDirectory, "x", "utf8");
    const fileResult = await checkProjectGit({ project_path: notDirectory, target_branch: "main" });
    assert.strictEqual(fileResult.status, "blocked");
    assert.match(fileResult.reason, /不是目錄/);

    const notRepo = path.join(root, "not-repo");
    fs.mkdirSync(notRepo);
    const repoResult = await checkProjectGit({ project_path: notRepo, target_branch: "main" });
    assert.strictEqual(repoResult.status, "blocked");
    assert.match(repoResult.reason, /不是 Git repository/);

    const queryFailure = await checkProjectGit(
      { project_path: repo, target_branch: "main" },
      { runGit: async () => { throw new Error("access denied"); } },
    );
    assert.strictEqual(queryFailure.status, "blocked");
    assert.match(queryFailure.reason, /Git 狀態檢查失敗.*access denied/);

    console.log("projectGitGate.test.js: Git 起跑條件與阻擋分類通過 ✅");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
