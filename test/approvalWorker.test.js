"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createApproval, findApproval, moveApproval, retryApproval, writeApproval } = require("../src/approvalStore");
const { pollApprovals, processApproval, recoverApprovals } = require("../src/approvalWorker");
const gitIdentity = require("../src/approvalGitIdentity");
const { writeTaskSession } = require("./support/codexSessionFixture");

const silentLogger = { log() {}, error() {} };

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(" ")} 失敗`);
  return String(result.stdout || "").trim();
}

function freshQueue() {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-worker-"));
  const project = path.join(queueDir, "project");
  fs.mkdirSync(project, { recursive: true });
  git(project, ["init", "-q"]);
  git(project, ["config", "--local", "user.name", "worker baseline"]);
  git(project, ["config", "--local", "user.email", "worker@example.invalid"]);
  return queueDir;
}

function taskFor(queueDir) {
  return {
    task: "skill-dispatch",
    project_path: path.join(queueDir, "project"),
    target_branch: "main",
  };
}

function pending(queueDir, id, approvedBy = "worker.tester") {
  writeTaskSession(queueDir, id);
  createApproval(
    queueDir,
    id,
    taskFor(queueDir),
    approvedBy,
    () => new Date("2026-07-21T01:00:00.000Z"),
  );
  return path.join(queueDir, "approvals", "pending", `${id}.json`);
}

function localName(queueDir) {
  return git(path.join(queueDir, "project"), ["config", "--local", "--get", "user.name"]);
}

function fakeGitVerification(result = {
  status: "success",
  commit_id: "b".repeat(40),
  commit_subject: "修改：完成驗收推送",
  committer_name: "worker.tester",
  identity_mismatch: false,
}) {
  return {
    preparePublishVerification: async () => ({
      before_head: "a".repeat(40),
      remote: "origin",
      branch: "main",
    }),
    verifyPublishedCommit: async () => result,
  };
}

(async () => {
  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "success");
    let sawProcessing = false;
    const logMessages = [];
    const order = [];
    const status = await processApproval(file, {
      queueDir,
      logger: { log(message) { logMessages.push(message); }, error() {} },
      nowFn: () => new Date("2026-07-21T02:00:00.000Z"),
      executor: async (event) => {
        order.push("codex");
        sawProcessing = fs.existsSync(path.join(queueDir, "approvals", "processing", "success.json"));
        assert.strictEqual(event.attempt, 1);
        assert.deepStrictEqual(event.publish, {
          status: "processing",
          before_head: "a".repeat(40),
          remote: "origin",
          branch: "main",
          started_at: "2026-07-21T02:00:00.000Z",
        });
        assert.strictEqual(localName(queueDir), "worker.tester", "Codex 執行期間必須套用驗收人名稱");
        return { delivered: true, output: "已收到" };
      },
      gitVerification: {
        preparePublishVerification: async () => ({
          before_head: "a".repeat(40),
          remote: "origin",
          branch: "main",
        }),
        verifyPublishedCommit: async () => {
          order.push("verify");
          return {
            status: "success",
            commit_id: "b".repeat(40),
            commit_subject: "修改：完成驗收推送",
            committer_name: "worker.tester",
            identity_mismatch: false,
          };
        },
      },
    });
    assert.strictEqual(status, "done");
    assert.strictEqual(sawProcessing, true);
    const saved = findApproval(queueDir, "success");
    assert.strictEqual(saved.status, "done");
    assert.strictEqual(saved.event.delivered_at, "2026-07-21T02:00:00.000Z");
    assert.deepStrictEqual(saved.event.result, { delivered: true, output: "已收到" });
    assert.strictEqual(saved.event.git_identity.applied_name, "worker.tester");
    assert.strictEqual(saved.event.git_identity.previous_local_name, "worker baseline");
    assert.ok(saved.event.git_identity.restored_at);
    assert.deepStrictEqual(saved.event.publish, {
      status: "success",
      before_head: "a".repeat(40),
      remote: "origin",
      branch: "main",
      started_at: "2026-07-21T02:00:00.000Z",
      commit_id: "b".repeat(40),
      commit_subject: "修改：完成驗收推送",
      committer_name: "worker.tester",
      identity_mismatch: false,
      finished_at: "2026-07-21T02:00:00.000Z",
    });
    assert.deepStrictEqual(order, ["codex", "verify"]);
    assert.strictEqual(localName(queueDir), "worker baseline", "成功後必須恢復原本名稱");
    assert.ok(logMessages.some((message) => message.includes("提交代碼並推送")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "failure");
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      nowFn: () => new Date("2026-07-21T03:00:00.000Z"),
      executor: async () => {
        assert.strictEqual(localName(queueDir), "worker.tester");
        throw new Error("Codex 無法啟動");
      },
      gitVerification: fakeGitVerification({ status: "failed", error: "遠端尚未更新" }),
    });
    assert.strictEqual(status, "failed");
    const saved = findApproval(queueDir, "failure");
    assert.strictEqual(saved.status, "failed");
    assert.strictEqual(saved.event.attempt, 1);
    assert.strictEqual(saved.event.last_error, "Codex 無法啟動；遠端尚未更新");
    assert.strictEqual(saved.event.failed_at, "2026-07-21T03:00:00.000Z");
    assert.strictEqual(localName(queueDir), "worker baseline", "Codex 失敗後仍須恢復原本名稱");
    assert.ok(!fs.existsSync(path.join(queueDir, "approvals", "pending", "failure.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "restore-failure");
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      executor: async () => ({ delivered: true, output: "已提交" }),
      gitIdentity: {
        ...gitIdentity,
        restoreLocalUserName: async () => { throw new Error("模擬還原失敗"); },
      },
      gitVerification: fakeGitVerification(),
    });
    assert.strictEqual(status, "failed", "身分還原失敗時 approval 必須失敗");
    const saved = findApproval(queueDir, "restore-failure");
    assert.match(saved.event.last_error, /還原.*失敗|可能殘留驗收人名稱/);
    assert.strictEqual(localName(queueDir), "worker.tester", "測試必須證明還原失敗會留下臨時名稱");
    retryApproval(queueDir, "restore-failure");
    let retryExecutorInvoked = false;
    const retriedStatus = await processApproval(
      path.join(queueDir, "approvals", "pending", "restore-failure.json"),
      {
        queueDir,
        logger: silentLogger,
        executor: async () => { retryExecutorInvoked = true; },
        gitVerification: {
          ...fakeGitVerification(),
          verifyPublishedCommit: async () => {
            assert.strictEqual(localName(queueDir), "worker baseline", "重試查遠端前必須先補還原 Git 身分");
            return fakeGitVerification().verifyPublishedCommit();
          },
        },
      },
    );
    assert.strictEqual(retriedStatus, "done");
    assert.strictEqual(retryExecutorInvoked, false, "遠端已成功時不得再次啟動 Codex");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "codex-error-but-pushed");
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      executor: async () => { throw new Error("Codex 回報失敗"); },
      gitVerification: fakeGitVerification(),
    });
    assert.strictEqual(status, "done", "遠端已有正確 commit 時仍應算推送成功");
    const saved = findApproval(queueDir, "codex-error-but-pushed");
    assert.strictEqual(saved.event.publish.status, "success");
    assert.ok(!saved.event.last_error);
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "unknown-result");
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      executor: async () => ({ delivered: true, output: "已執行" }),
      gitVerification: fakeGitVerification({ status: "unknown", error: "ssh timeout\nPermission denied" }),
    });
    assert.strictEqual(status, "unknown");
    const saved = findApproval(queueDir, "unknown-result");
    assert.strictEqual(saved.status, "unknown");
    assert.strictEqual(saved.event.publish.status, "unknown");
    assert.strictEqual(saved.event.last_error, "ssh timeout Permission denied");
    assert.ok(!saved.event.publish.error.includes("\n"), "保存的 Git 錯誤必須壓成單行");
    retryApproval(queueDir, "unknown-result");
    const retried = await processApproval(
      path.join(queueDir, "approvals", "pending", "unknown-result.json"),
      {
        queueDir,
        logger: silentLogger,
        executor: async () => { throw new Error("遠端成功時不應重跑 Codex"); },
        gitVerification: fakeGitVerification(),
      },
    );
    assert.strictEqual(retried, "done", "多行 Git 錯誤保存後仍必須可人工重試");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "retry-already-pushed");
    const existing = findApproval(queueDir, "retry-already-pushed").event;
    existing.attempt = 1;
    existing.last_error = "先前無法確認";
    existing.publish = {
      status: "unknown",
      before_head: "a".repeat(40),
      remote: "origin",
      branch: "main",
      error: "先前無法確認",
    };
    writeApproval(queueDir, "pending", existing);
    moveApproval(queueDir, "pending", "unknown", "retry-already-pushed");
    retryApproval(queueDir, "retry-already-pushed");
    let codexInvoked = false;
    const status = await processApproval(
      path.join(queueDir, "approvals", "pending", "retry-already-pushed.json"),
      {
        queueDir,
        logger: silentLogger,
        executor: async () => { codexInvoked = true; },
        gitVerification: fakeGitVerification(),
      },
    );
    assert.strictEqual(status, "done");
    assert.strictEqual(codexInvoked, false, "重試前已確認成功時不得再啟動 Codex");
    assert.strictEqual(findApproval(queueDir, "retry-already-pushed").event.attempt, 2);
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const file = pending(queueDir, "setup-failure");
    let invoked = false;
    const status = await processApproval(file, {
      queueDir,
      logger: silentLogger,
      executor: async () => { invoked = true; },
      gitIdentity: {
        ...gitIdentity,
        setLocalUserName: async () => { throw new Error("模擬設定失敗"); },
      },
      gitVerification: fakeGitVerification({ status: "failed", error: "遠端尚未更新" }),
    });
    assert.strictEqual(status, "failed");
    assert.strictEqual(invoked, false, "名稱設定失敗時不得啟動 Codex");
    assert.strictEqual(localName(queueDir), "worker baseline");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "interrupted");
    const interrupted = findApproval(queueDir, "interrupted").event;
    interrupted.git_identity = {
      previous_local_name_present: true,
      previous_local_name: "worker baseline",
      applied_name: "worker.tester",
      prepared_at: "2026-07-21T03:30:00.000Z",
    };
    interrupted.publish = {
      status: "processing",
      before_head: "a".repeat(40),
      remote: "origin",
      branch: "main",
      started_at: "2026-07-21T03:30:00.000Z",
    };
    moveApproval(queueDir, "pending", "processing", "interrupted");
    writeApproval(queueDir, "processing", interrupted);
    git(path.join(queueDir, "project"), ["config", "--local", "user.name", "worker.tester"]);
    const recovered = await recoverApprovals(
      queueDir,
      silentLogger,
      () => new Date("2026-07-21T04:00:00.000Z"),
      { gitVerification: fakeGitVerification() },
    );
    assert.strictEqual(recovered, 1);
    const saved = findApproval(queueDir, "interrupted");
    assert.strictEqual(saved.status, "done");
    assert.strictEqual(saved.event.publish.status, "success");
    assert.strictEqual(saved.event.publish.finished_at, "2026-07-21T04:00:00.000Z");
    assert.strictEqual(saved.event.publish.commit_subject, "修改：完成驗收推送");
    assert.ok(!saved.event.delivery_uncertain_at);
    assert.strictEqual(saved.event.git_identity.restored_at, "2026-07-21T04:00:00.000Z");
    assert.strictEqual(localName(queueDir), "worker baseline", "重啟回收必須先恢復原本名稱");
    assert.ok(!fs.existsSync(path.join(queueDir, "approvals", "pending", "interrupted.json")));
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "interrupted-restore-failure");
    const interrupted = findApproval(queueDir, "interrupted-restore-failure").event;
    interrupted.git_identity = {
      previous_local_name_present: true,
      previous_local_name: "worker baseline",
      applied_name: "worker.tester",
      prepared_at: "2026-07-21T04:30:00.000Z",
    };
    interrupted.publish = {
      status: "processing",
      before_head: "a".repeat(40),
      remote: "origin",
      branch: "main",
      started_at: "2026-07-21T04:30:00.000Z",
    };
    moveApproval(queueDir, "pending", "processing", "interrupted-restore-failure");
    writeApproval(queueDir, "processing", interrupted);
    git(path.join(queueDir, "project"), ["config", "--local", "user.name", "worker.tester"]);
    await assert.rejects(
      () => recoverApprovals(queueDir, silentLogger, () => new Date(), {
        gitIdentity: {
          ...gitIdentity,
          restoreLocalUserName: async () => { throw new Error("模擬重啟還原失敗"); },
        },
      }),
      /重啟.*還原失敗|可能殘留驗收人名稱/,
      "補還原失敗時必須在保存 failed 後阻止 worker 繼續啟動",
    );
    const saved = findApproval(queueDir, "interrupted-restore-failure");
    assert.strictEqual(saved.status, "failed");
    assert.match(saved.event.last_error, /重啟.*還原失敗|可能殘留驗收人名稱/);
    assert.strictEqual(saved.event.publish.status, "failed");
    assert.match(saved.event.publish.error, /還原失敗|可能殘留驗收人名稱/);
    assert.strictEqual(localName(queueDir), "worker.tester");
    const recoveredAfterFailure = await recoverApprovals(
      queueDir,
      silentLogger,
      () => new Date("2026-07-21T04:45:00.000Z"),
      { gitVerification: fakeGitVerification() },
    );
    assert.strictEqual(recoveredAfterFailure, 1, "下次啟動必須重試 failed 事件的 Git 身分還原");
    assert.strictEqual(findApproval(queueDir, "interrupted-restore-failure").status, "done");
    assert.strictEqual(localName(queueDir), "worker baseline");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  for (const [taskId, verificationStatus] of [
    ["interrupted-failed", "failed"],
    ["interrupted-unknown", "unknown"],
  ]) {
    const queueDir = freshQueue();
    pending(queueDir, taskId);
    const interrupted = findApproval(queueDir, taskId).event;
    interrupted.git_identity = {
      previous_local_name_present: true,
      previous_local_name: "worker baseline",
      applied_name: "worker.tester",
      prepared_at: "2026-07-21T05:00:00.000Z",
    };
    interrupted.publish = {
      status: "processing",
      before_head: "a".repeat(40),
      remote: "origin",
      branch: "main",
      started_at: "2026-07-21T05:00:00.000Z",
    };
    moveApproval(queueDir, "pending", "processing", taskId);
    writeApproval(queueDir, "processing", interrupted);
    git(path.join(queueDir, "project"), ["config", "--local", "user.name", "worker.tester"]);
    const recovered = await recoverApprovals(
      queueDir,
      silentLogger,
      () => new Date("2026-07-21T05:30:00.000Z"),
      { gitVerification: fakeGitVerification({ status: verificationStatus, error: `驗證${verificationStatus}` }) },
    );
    assert.strictEqual(recovered, 1);
    const saved = findApproval(queueDir, taskId);
    assert.strictEqual(saved.status, verificationStatus);
    assert.strictEqual(saved.event.publish.status, verificationStatus);
    assert.strictEqual(saved.event.publish.error, `驗證${verificationStatus}`);
    assert.strictEqual(localName(queueDir), "worker baseline", "重啟時必須先還原 Git 身分");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    const pendingDir = path.join(queueDir, "approvals", "pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, "bad-pending.json"), "{bad", "utf8");
    fs.writeFileSync(path.join(pendingDir, "partial-pending.json"), "{}", "utf8");
    pending(queueDir, "good-after-bad");
    const seen = [];
    const count = await pollApprovals({
      queueDir,
      logger: silentLogger,
      executor: async (event) => {
        seen.push(event.task_id);
        return { delivered: true, output: "ok" };
      },
      gitVerification: fakeGitVerification(),
    });
    assert.strictEqual(count, 3);
    assert.deepStrictEqual(seen, ["good-after-bad"]);
    assert.strictEqual(findApproval(queueDir, "bad-pending").status, "failed");
    assert.strictEqual(findApproval(queueDir, "partial-pending").status, "failed");

    const processingDir = path.join(queueDir, "approvals", "processing");
    fs.mkdirSync(processingDir, { recursive: true });
    fs.writeFileSync(path.join(processingDir, "bad-processing.json"), "{bad", "utf8");
    await assert.doesNotReject(() => recoverApprovals(queueDir, silentLogger));
    assert.strictEqual(findApproval(queueDir, "bad-processing").status, "failed");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  {
    const queueDir = freshQueue();
    pending(queueDir, "b");
    pending(queueDir, "a");
    const seen = [];
    const count = await pollApprovals({
      queueDir,
      logger: silentLogger,
      executor: async (event) => {
        seen.push(event.task_id);
        return { delivered: true, output: "ok" };
      },
      gitVerification: fakeGitVerification(),
    });
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(seen, ["a", "b"]);
    assert.strictEqual(findApproval(queueDir, "a").status, "done");
    assert.strictEqual(findApproval(queueDir, "b").status, "done");
    fs.rmSync(queueDir, { recursive: true, force: true });
  }

  const repo = path.resolve(__dirname, "..");
  const workerSource = fs.readFileSync(path.join(repo, "src", "worker.js"), "utf8");
  const workerStartupSource = fs.readFileSync(path.join(repo, "src", "workerStartup.js"), "utf8");
  const configSource = fs.readFileSync(path.join(repo, "src", "config.js"), "utf8");
  assert.ok(workerSource.includes("prepareWorkerRuntime") && workerSource.includes("pollApprovals"));
  assert.ok(workerStartupSource.includes("recoverApprovals") && workerStartupSource.includes("preflightCodexRuntime"));
  assert.ok(!workerSource.includes("maxApprovalAttempts"));
  assert.ok(!configSource.includes("MAX_APPROVAL_ATTEMPTS"));
  assert.ok(!fs.readFileSync(path.join(repo, ".env.example"), "utf8").includes("MAX_APPROVAL_ATTEMPTS"));

  console.log("approvalWorker.test.js: 單次通知與中斷防重送通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
