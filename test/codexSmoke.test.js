"use strict";
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCodex } = require("../src/codexRunner");
const { agentExecutor } = require("../src/executors/agentExecutor");
const { approvalExecutor } = require("../src/executors/approvalExecutor");
const { createApproval } = require("../src/approvalStore");
const { TASK_RESULT_SCHEMA } = require("../src/executors/taskResult");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-codex-smoke-"));
const repoDir = path.join(tempRoot, "project");
const remoteDir = path.join(tempRoot, "remote.git");
const queueDir = path.join(tempRoot, "queue");
function git(args, cwd = repoDir) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(" ")} 失敗`);
  return String(result.stdout || "").trim();
}

function runSmokeCodex(prompt, cwd) {
  return runCodex(prompt, {
    mode: "execute",
    cwd,
    timeoutMs: 600000,
    outputSchema: TASK_RESULT_SCHEMA,
  });
}

(async () => {
  try {
    fs.mkdirSync(repoDir, { recursive: true });
    git(["init", "--bare", "-q", remoteDir], tempRoot);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "element-bot smoke"]);
    git(["config", "user.email", "element-bot-smoke@example.invalid"]);
    fs.writeFileSync(path.join(repoDir, "baseline.txt"), "baseline\n", "utf8");
    git(["add", "baseline.txt"]);
    git(["commit", "-q", "-m", "test: baseline"]);
    git(["remote", "add", "origin", remoteDir]);
    git(["push", "-q", "-u", "origin", "main"]);
    const baselineHead = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repoDir, "human-dirty.txt"), "不得被發布\n", "utf8");

    const taskId = "smoke-task-a";
    const task = {
      task: "skill-dispatch",
      project_path: repoDir,
      target_branch: "main",
      command: "在 Task 專屬工作區新增 approved-task.txt，內容必須完全是 APPROVED_TASK_A 加換行；完成驗證後回報 success。",
    };
    const summary = await agentExecutor(task, {
      queueDir,
      id: taskId,
      logger: { log() {}, error() {} },
      ops: { runCodex: runSmokeCodex },
    });
    assert.strictEqual(summary.status, "success");
    const workspaceA = path.join(queueDir, "work", taskId, "workspace");
    assert.strictEqual(fs.readFileSync(path.join(workspaceA, "approved-task.txt"), "utf8"), "APPROVED_TASK_A\n");
    assert.strictEqual(git(["rev-parse", "HEAD"]), baselineHead, "驗收前不得 commit");
    assert.strictEqual(git(["rev-parse", "HEAD"], workspaceA), baselineHead, "驗收前 worktree HEAD 不變");
    assert.ok(fs.existsSync(path.join(repoDir, "human-dirty.txt")), "共用工作目錄的既有 dirty change 必須保留");

    const workspaceB = path.join(queueDir, "work", "smoke-task-b", "workspace");
    fs.mkdirSync(path.dirname(workspaceB), { recursive: true });
    git(["worktree", "add", "-q", "--detach", workspaceB, "main"]);
    fs.writeFileSync(path.join(workspaceB, "other-task.txt"), "TASK_B_NOT_APPROVED\n", "utf8");

    const created = createApproval(queueDir, taskId, task, "Smoke 驗收人", () => new Date("2026-07-21T01:02:03.000Z"));
    const result = await approvalExecutor(created.event, {
      runCodex: runSmokeCodex,
    });
    assert.strictEqual(result.status, "success");
    assert.strictEqual(git(["show", "main:approved-task.txt"], remoteDir), "APPROVED_TASK_A");
    assert.notStrictEqual(git(["rev-parse", "main"], remoteDir), baselineHead);
    assert.throws(() => git(["show", "main:other-task.txt"], remoteDir));
    assert.throws(() => git(["show", "main:human-dirty.txt"], remoteDir));
    const message = git(["log", "-1", "--format=%B", "main"], remoteDir);
    assert.match(message, /Task-ID: smoke-task-a/);
    assert.match(message, /Approved-by: Smoke 驗收人/);
    const commitCount = git(["rev-list", "--count", "main"], remoteDir);

    const repeated = await approvalExecutor(created.event, { runCodex: runSmokeCodex });
    assert.strictEqual(repeated.status, "success");
    assert.strictEqual(git(["rev-list", "--count", "main"], remoteDir), commitCount, "重送不得重複 commit");
    assert.strictEqual(fs.readFileSync(path.join(workspaceB, "other-task.txt"), "utf8"), "TASK_B_NOT_APPROVED\n");
    assert.ok(fs.existsSync(path.join(repoDir, "human-dirty.txt")));

    console.log("codexSmoke.test.js: 真實 Codex 專屬 worktree、commit/push、trailers 與冪等通過 ✅");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
