"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createApproval } = require("../src/approvalStore");
const { createClosure } = require("../src/taskClosureStore");
const { writeTaskSession } = require("./support/codexSessionFixture");

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

    const queueDir = path.join(root, "queue");
    writeTaskSession(queueDir, "publishing-task");
    createApproval(queueDir, "publishing-task", {
      task: "skill-dispatch",
      project_path: repo,
      target_branch: "main",
    }, "patrick.zyx");
    const gated = await checkProjectGit(
      { project_path: repo, target_branch: "main" },
      { queueDir, id: "next-task" },
    );
    assert.strictEqual(gated.status, "waiting");
    assert.match(gated.reason, /同一專案.*推送.*尚未結案/);

    const otherRepo = path.join(root, "other-repo");
    fs.mkdirSync(otherRepo, { recursive: true });
    git(["init", "-q", "-b", "main"], otherRepo);
    git(["config", "user.name", "element-bot test"], otherRepo);
    git(["config", "user.email", "element-bot-test@example.invalid"], otherRepo);
    fs.writeFileSync(path.join(otherRepo, "baseline.txt"), "baseline\n", "utf8");
    git(["add", "baseline.txt"], otherRepo);
    git(["commit", "-q", "-m", "test: baseline"], otherRepo);
    const otherProject = await checkProjectGit(
      { project_path: otherRepo, target_branch: "main" },
      { queueDir, id: "other-task" },
    );
    assert.strictEqual(otherProject.status, "ready", "其他專案不應被驗收推送擋住");

    createClosure(queueDir, "publishing-task", "patrick.zyx");
    fs.mkdirSync(path.join(queueDir, "approvals", "failed"), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "approvals", "failed", "legacy-failed.json"), JSON.stringify({
      task_id: "legacy-failed",
      project_path: repo,
      target_branch: "main",
      approved_by: "patrick.zyx",
      approved_at: "2026-07-21T02:00:00.000Z",
      message: "提交代碼",
      attempt: 1,
    }), "utf8");
    const released = await checkProjectGit(
      { project_path: repo, target_branch: "main" },
      { queueDir, id: "next-task" },
    );
    assert.strictEqual(released.status, "ready", "沒有 publish 的歷史失敗事件不得永久阻擋專案");

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
