"use strict";
const { execFile, spawnSync } = require("child_process");

const LOCAL_GIT_TIMEOUT_MS = 10000;
const REMOTE_GIT_TIMEOUT_MS = 3000;
const REMOTE_RETRY_DELAYS_MS = [2000, 5000];

function detail(error, stderr) {
  return String(stderr || (error && error.message) || error || "未知錯誤")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function terminateProcessTree(child, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  if (platform === "win32" && child && child.pid) {
    const result = spawnSyncFn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (!result.error && result.status === 0) return;
  }
  if (child && typeof child.kill === "function") child.kill();
}

function runGit(projectPath, args, options = {}) {
  const allowedExitCodes = options.allowedExitCodes || [];
  const execFileFn = options.execFileFn || execFile;
  const terminateFn = options.terminateFn || terminateProcessTree;
  const timeoutMs = options.timeoutMs || (options.remote ? REMOTE_GIT_TIMEOUT_MS : LOCAL_GIT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const execOptions = {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: options.remote
        ? { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        : process.env,
    };
    const onExit = (error, stdout, stderr) => {
      if (!error) return finish(resolve, { code: 0, stdout: String(stdout || "").trim() });
      if (allowedExitCodes.includes(error.code)) {
        return finish(resolve, { code: error.code, stdout: String(stdout || "").trim() });
      }
      error.gitDetail = detail(error, stderr);
      finish(reject, error);
    };
    child = options.execFileFn
      ? execFileFn("git", args, execOptions, onExit)
      : execFile("git", args, execOptions, onExit);
    if (!settled) {
      timer = setTimeout(() => {
        terminateFn(child);
        const error = new Error(`Git timeout(${timeoutMs}ms)`);
        error.code = "ETIMEDOUT";
        error.gitDetail = detail(error);
        finish(reject, error);
      }, timeoutMs);
    }
  });
}

function remoteBranch(mergeRef, targetBranch) {
  const prefix = "refs/heads/";
  if (typeof mergeRef === "string" && mergeRef.startsWith(prefix) && mergeRef.length > prefix.length) {
    return mergeRef.slice(prefix.length);
  }
  return targetBranch;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRemoteHead(projectPath, prepared, deps) {
  const git = deps.runGit || runGit;
  const wait = deps.sleep || sleep;
  const remoteRef = `refs/heads/${prepared.branch}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await git(
        projectPath,
        ["ls-remote", "--heads", prepared.remote, remoteRef],
        { remote: true },
      );
      return { status: "ok", head: result.stdout.split(/\s+/)[0] || "" };
    } catch (error) {
      lastError = error;
      if (attempt < REMOTE_RETRY_DELAYS_MS.length) {
        await wait(REMOTE_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  return {
    status: "unknown",
    error: `無法確認遠端 ${prepared.remote}/${prepared.branch}：${detail(lastError, lastError && lastError.gitDetail)}`,
  };
}

async function preparePublishVerification(projectPath, targetBranch, deps = {}) {
  const git = deps.runGit || runGit;
  const before = await git(projectPath, ["rev-parse", "HEAD"]);
  const currentBranch = (await git(projectPath, ["branch", "--show-current"])).stdout;
  if (!currentBranch) throw new Error(`目前為 detached HEAD，目標分支為 ${targetBranch}`);
  if (currentBranch !== targetBranch) {
    throw new Error(`目前分支為 ${currentBranch}，目標分支為 ${targetBranch}`);
  }
  const remote = await git(
    projectPath,
    ["config", "--get", `branch.${currentBranch}.remote`],
    { allowedExitCodes: [1] },
  );
  const merge = await git(
    projectPath,
    ["config", "--get", `branch.${currentBranch}.merge`],
    { allowedExitCodes: [1] },
  );

  if (remote.code === 0 && remote.stdout && remote.stdout !== "." && merge.code === 0) {
    return {
      before_head: before.stdout,
      remote: remote.stdout,
      branch: remoteBranch(merge.stdout, targetBranch),
    };
  }

  const remotes = (await git(projectPath, ["remote"])).stdout.split(/\r?\n/).filter(Boolean);
  if (remotes.length === 1) {
    return { before_head: before.stdout, remote: remotes[0], branch: targetBranch };
  }
  throw new Error(remotes.length === 0
    ? "專案沒有可驗證的 Git remote"
    : "目前分支沒有 upstream，且專案有多個 remote，無法判定推送目的地");
}

async function verifyPublishedCommit(projectPath, prepared, approvedBy, deps = {}) {
  const git = deps.runGit || runGit;
  const head = (await git(projectPath, ["rev-parse", "HEAD"])).stdout;
  if (head === prepared.before_head) {
    return { status: "failed", error: "驗收後沒有產生新的 commit" };
  }

  const ancestry = await git(
    projectPath,
    ["merge-base", "--is-ancestor", prepared.before_head, head],
    { allowedExitCodes: [1] },
  );
  if (ancestry.code === 1) {
    return { status: "failed", error: "目前 HEAD 不是驗收前 HEAD 的後續 commit" };
  }

  const shown = await git(projectPath, ["show", "-s", "--format=%H%x00%s%x00%cn", head]);
  const [commitId, commitSubject, committerName] = shown.stdout.split("\0");
  const remote = await readRemoteHead(projectPath, prepared, deps);
  if (remote.status === "unknown") return remote;
  const remoteHead = remote.head;
  if (remoteHead !== head) {
    return { status: "failed", error: `遠端 ${prepared.remote}/${prepared.branch} 尚未指向本次 commit` };
  }

  return {
    status: "success",
    commit_id: commitId,
    commit_subject: commitSubject,
    committer_name: committerName,
    identity_mismatch: committerName !== approvedBy,
  };
}

module.exports = { preparePublishVerification, runGit, terminateProcessTree, verifyPublishedCommit };
