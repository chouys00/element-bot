"use strict";
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCodex } = require("../src/codexRunner");
const { pollOnce } = require("../src/workerCore");
const { checkProjectGit } = require("../src/projectGitGate");
const { agentExecutor } = require("../src/executors/agentExecutor");
const { approvalExecutor } = require("../src/executors/approvalExecutor");
const { createApproval, findApproval } = require("../src/approvalStore");
const { pollApprovals } = require("../src/approvalWorker");
const { TASK_RESULT_SCHEMA } = require("../src/executors/taskResult");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-codex-smoke-"));
const repoDir = path.join(tempRoot, "project");
const remoteDir = path.join(tempRoot, "remote.git");
const queueDir = path.join(tempRoot, "queue");
const silentLogger = { log() {}, error() {} };

function git(args, cwd = repoDir) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
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

function writePending(id, task) {
  const pendingDir = path.join(queueDir, "pending");
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, `${id}.json`), JSON.stringify(task), "utf8");
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

    const taskId = "smoke-task-a";
    const task = {
      task: "skill-dispatch",
      project_path: repoDir,
      target_branch: "main",
      command: "直接在目前專案新增 approved-task.txt，內容必須完全是 APPROVED_TASK_A 加換行；完成驗證後回報 success。",
    };
    writePending(taskId, task);

    const processed = await pollOnce({
      queueDir,
      logger: silentLogger,
      preflight: checkProjectGit,
      executor: (queuedTask, context) => agentExecutor(queuedTask, {
        ...context,
        ops: { runCodex: runSmokeCodex },
      }),
    });
    assert.strictEqual(processed, 1);
    assert.ok(fs.existsSync(path.join(queueDir, "done", `${taskId}.json`)));
    assert.strictEqual(fs.readFileSync(path.join(repoDir, "approved-task.txt"), "utf8"), "APPROVED_TASK_A\n");
    assert.strictEqual(git(["rev-parse", "HEAD"]), baselineHead, "驗收前不得 commit");
    assert.match(git(["status", "--porcelain", "--", "."]), /approved-task\.txt/);
    assert.ok(!fs.existsSync(path.join(queueDir, "work", taskId, "workspace")), "不得建立 Task worktree");

    const taskB = {
      ...task,
      command: "新增 other-task.txt",
    };
    writePending("smoke-task-b", taskB);
    let secondExecutions = 0;
    const waiting = await pollOnce({
      queueDir,
      logger: silentLogger,
      preflight: checkProjectGit,
      executor: async () => {
        secondExecutions++;
        return { queueStatus: "done" };
      },
    });
    assert.strictEqual(waiting, 0);
    assert.strictEqual(secondExecutions, 0);
    assert.ok(fs.existsSync(path.join(queueDir, "pending", "smoke-task-b.json")));

    const created = createApproval(
      queueDir,
      taskId,
      task,
      "smoke.tester",
      () => new Date("2026-07-27T01:02:03.000Z"),
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(created.event, "workspace_path"));
    assert.strictEqual(created.event.message, "提交代碼並推送");
    const delivered = await pollApprovals({
      queueDir,
      logger: silentLogger,
      executor: (event) => approvalExecutor(event, { runCodex: runSmokeCodex }),
    });
    assert.strictEqual(delivered, 1);
    const saved = findApproval(queueDir, taskId);
    assert.strictEqual(saved.status, "done");
    assert.strictEqual(saved.event.result.delivered, true);
    assert.ok(saved.event.result.output.length > 0);
    const approvedHead = git(["rev-parse", "HEAD"]);
    assert.notStrictEqual(approvedHead, baselineHead, "驗收通知後應由目標專案建立 commit");
    assert.strictEqual(git(["log", "-1", "--format=%an"]), "smoke.tester", "Author 應為驗收人");
    assert.strictEqual(git(["log", "-1", "--format=%cn"]), "smoke.tester", "Committer 應為驗收人");
    assert.strictEqual(
      git(["config", "--local", "--get", "user.name"]),
      "element-bot smoke",
      "Codex 結束後應恢復原本 local user.name",
    );
    assert.strictEqual(git(["status", "--porcelain", "--", "."]), "", "驗收提交後工作樹應乾淨");

    console.log("codexSmoke.test.js: 真實 Codex 直接 project_path、Git 閘門與驗收通知通過 ✅");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
