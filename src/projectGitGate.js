"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const GIT_TIMEOUT_MS = 10000;

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.gitStderr = String(stderr || "").trim();
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function blocked(reason) {
  return { status: "blocked", reason };
}

function gitErrorMessage(error) {
  return String((error && (error.gitStderr || error.message)) || error || "未知錯誤").trim();
}

async function checkProjectGit(task, deps = {}) {
  const rawPath = String((task && task.project_path) || "").trim();
  if (!rawPath || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    return blocked("project_path 不合法");
  }
  const targetBranch = String((task && task.target_branch) || "").trim();
  if (!targetBranch || targetBranch.length > 255 || /[\u0000-\u001f\u007f]/.test(targetBranch)) {
    return blocked("target_branch 不合法");
  }

  const projectPath = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.statSync(projectPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return blocked(`project_path 不存在: ${projectPath}`);
    return blocked(`無法讀取 project_path: ${projectPath}`);
  }
  if (!stat.isDirectory()) return blocked(`project_path 不是目錄: ${projectPath}`);

  const git = deps.runGit || runGit;
  let inside;
  try {
    inside = await git(["rev-parse", "--is-inside-work-tree"], projectPath);
  } catch (error) {
    const detail = gitErrorMessage(error);
    if (/not a git repository/i.test(detail)) {
      return blocked(`project_path 不是 Git repository: ${projectPath}`);
    }
    return blocked(`Git 狀態檢查失敗: ${detail}`);
  }
  if (inside !== "true") return blocked(`project_path 不是 Git working tree: ${projectPath}`);

  let branch;
  let changes;
  try {
    branch = await git(["branch", "--show-current"], projectPath);
    if (!branch) {
      return {
        status: "waiting",
        reason: `目前為 detached HEAD，任務要求 ${targetBranch}`,
        branch: "",
      };
    }
    if (branch !== targetBranch) {
      return {
        status: "waiting",
        reason: `目前分支為 ${branch}，任務要求 ${targetBranch}`,
        branch,
      };
    }
    changes = await git(
      ["status", "--porcelain", "--untracked-files=normal", "--", "."],
      projectPath,
    );
  } catch (error) {
    return blocked(`Git 狀態檢查失敗: ${gitErrorMessage(error)}`);
  }

  if (changes) {
    return {
      status: "waiting",
      reason: "project_path 有未提交變更，請先提交、還原或清理後再執行",
      branch,
    };
  }

  return { status: "ready", projectPath, branch };
}

module.exports = { checkProjectGit };
