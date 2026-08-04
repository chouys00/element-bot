"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  preparePublishVerification,
  runGit,
  terminateProcessTree,
  verifyPublishedCommit,
} = require("../src/approvalGitVerification");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-git-verification-"));
const projectPath = path.join(root, "project");
const remotePath = path.join(root, "remote.git");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(" ")} 失敗`);
  return String(result.stdout || "").trim();
}

(async () => {
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    git(projectPath, ["init", "-q", "-b", "main"]);
    git(projectPath, ["config", "user.name", "baseline.user"]);
    git(projectPath, ["config", "user.email", "baseline@example.invalid"]);
    fs.writeFileSync(path.join(projectPath, "marker.txt"), "before\n", "utf8");
    git(projectPath, ["add", "marker.txt"]);
    git(projectPath, ["commit", "-q", "-m", "建立基準"]);
    git(root, ["init", "--bare", "-q", remotePath]);
    git(projectPath, ["remote", "add", "origin", remotePath]);
    git(projectPath, ["push", "-q", "-u", "origin", "main"]);

    const prepared = await preparePublishVerification(projectPath, "main");
    assert.strictEqual(prepared.remote, "origin");
    assert.strictEqual(prepared.branch, "main");
    assert.strictEqual(prepared.before_head, git(projectPath, ["rev-parse", "HEAD"]));

    git(projectPath, ["checkout", "-q", "-b", "other"]);
    await assert.rejects(
      () => preparePublishVerification(projectPath, "main"),
      /目前分支.*other.*目標分支.*main/,
    );
    git(projectPath, ["checkout", "-q", "main"]);

    assert.deepStrictEqual(
      await verifyPublishedCommit(projectPath, prepared, "patrick.zyx"),
      { status: "failed", error: "驗收後沒有產生新的 commit" },
    );

    git(projectPath, ["config", "user.name", "patrick.zyx"]);
    fs.writeFileSync(path.join(projectPath, "marker.txt"), "after\n", "utf8");
    git(projectPath, ["add", "marker.txt"]);
    git(projectPath, ["commit", "-q", "-m", "修改：更新驗收標記\n\n不應顯示的詳細內容"]);
    git(projectPath, ["push", "-q", "origin", "main"]);

    const result = await verifyPublishedCommit(projectPath, prepared, "patrick.zyx");
    assert.deepStrictEqual(result, {
      status: "success",
      commit_id: git(projectPath, ["rev-parse", "HEAD"]),
      commit_subject: "修改：更新驗收標記",
      committer_name: "patrick.zyx",
      identity_mismatch: false,
    });

    git(projectPath, ["config", "user.name", "other.user"]);
    fs.writeFileSync(path.join(projectPath, "identity.txt"), "other\n", "utf8");
    git(projectPath, ["add", "identity.txt"]);
    git(projectPath, ["commit", "-q", "-m", "修改：驗證提交者警告"]);
    git(projectPath, ["push", "-q", "origin", "main"]);
    const mismatch = await verifyPublishedCommit(projectPath, prepared, "patrick.zyx");
    assert.strictEqual(mismatch.status, "success");
    assert.strictEqual(mismatch.committer_name, "other.user");
    assert.strictEqual(mismatch.identity_mismatch, true);

    git(projectPath, ["config", "user.name", "patrick.zyx"]);
    fs.writeFileSync(path.join(projectPath, "marker.txt"), "retry\n", "utf8");
    git(projectPath, ["add", "marker.txt"]);
    git(projectPath, ["commit", "-q", "-m", "修改：驗證遠端重試"]);
    assert.deepStrictEqual(
      await verifyPublishedCommit(projectPath, prepared, "patrick.zyx"),
      { status: "failed", error: "遠端 origin/main 尚未指向本次 commit" },
    );
    git(projectPath, ["push", "-q", "origin", "main"]);
    let remoteAttempts = 0;
    const transient = await verifyPublishedCommit(projectPath, prepared, "patrick.zyx", {
      sleep: async () => {},
      runGit: async (cwd, args, options) => {
        if (args[0] === "ls-remote" && ++remoteAttempts < 3) {
          const error = new Error("模擬遠端暫時無法連線");
          error.code = "ETIMEDOUT";
          throw error;
        }
        return runGit(cwd, args, options);
      },
    });
    assert.strictEqual(transient.status, "success");
    assert.strictEqual(remoteAttempts, 3, "遠端查詢應最多重試三次並在成功後停止");

    const unavailable = await verifyPublishedCommit(projectPath, prepared, "patrick.zyx", {
      sleep: async () => {},
      runGit: async (cwd, args, options) => {
        if (args[0] === "ls-remote") {
          const error = new Error("模擬遠端持續逾時");
          error.code = "ETIMEDOUT";
          error.gitDetail = "ssh: connect timeout\nPermission denied";
          throw error;
        }
        return runGit(cwd, args, options);
      },
    });
    assert.deepStrictEqual(unavailable, {
      status: "unknown",
      error: "無法確認遠端 origin/main：ssh: connect timeout Permission denied",
    });

    const unrelatedCommit = git(projectPath, ["commit-tree", "HEAD^{tree}", "-m", "建立無關歷史"]);
    git(projectPath, ["update-ref", "refs/heads/unrelated", unrelatedCommit]);
    git(projectPath, ["checkout", "-q", "unrelated"]);
    git(projectPath, ["push", "-q", "--force", "origin", "HEAD:main"]);
    assert.deepStrictEqual(
      await verifyPublishedCommit(projectPath, prepared, "patrick.zyx"),
      { status: "failed", error: "目前 HEAD 不是驗收前 HEAD 的後續 commit" },
      "回退或切到無關歷史後即使遠端一致，也不能算本次新 commit",
    );

    const fallbackPath = path.join(root, "fallback-project");
    const fallbackRemote = path.join(root, "fallback.git");
    fs.mkdirSync(fallbackPath, { recursive: true });
    git(fallbackPath, ["init", "-q", "-b", "main"]);
    git(fallbackPath, ["config", "user.name", "fallback.user"]);
    git(fallbackPath, ["config", "user.email", "fallback@example.invalid"]);
    fs.writeFileSync(path.join(fallbackPath, "file.txt"), "fallback\n", "utf8");
    git(fallbackPath, ["add", "file.txt"]);
    git(fallbackPath, ["commit", "-q", "-m", "建立單一遠端測試"]);
    git(root, ["init", "--bare", "-q", fallbackRemote]);
    git(fallbackPath, ["remote", "add", "backup", fallbackRemote]);
    git(fallbackPath, ["push", "-q", "backup", "main"]);
    const fallback = await preparePublishVerification(fallbackPath, "main");
    assert.deepStrictEqual(fallback, {
      before_head: git(fallbackPath, ["rev-parse", "HEAD"]),
      remote: "backup",
      branch: "main",
    });
    git(fallbackPath, ["remote", "add", "mirror", remotePath]);
    await assert.rejects(
      () => preparePublishVerification(fallbackPath, "main"),
      /多個 remote.*無法判定推送目的地/,
    );

    let terminatedChild = null;
    const fakeChild = { pid: 123, kill() {} };
    await assert.rejects(
      () => runGit(projectPath, ["ls-remote", "origin"], {
        remote: true,
        timeoutMs: 5,
        execFileFn: () => fakeChild,
        terminateFn: (child) => { terminatedChild = child; },
      }),
      /timeout\(5ms\)/,
    );
    assert.strictEqual(terminatedChild, fakeChild, "遠端逾時必須終止 Git process tree");

    let taskkillArgs = null;
    let directKillCalled = false;
    terminateProcessTree({ pid: 456, kill() { directKillCalled = true; } }, {
      platform: "win32",
      spawnSyncFn: (_command, args) => { taskkillArgs = args; return { status: 0 }; },
    });
    assert.deepStrictEqual(taskkillArgs, ["/pid", "456", "/t", "/f"]);
    assert.strictEqual(directKillCalled, false, "Windows taskkill /T 成功後不需只殺直接子程序");

    console.log("approvalGitVerification.test.js: upstream、單一遠端 fallback、重試與未知結果驗證通過 ✅");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
