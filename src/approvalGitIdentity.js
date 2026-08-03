"use strict";
const { execFile } = require("child_process");

const GIT_TIMEOUT_MS = 10000;

function detail(error, stderr) {
  return String(stderr || (error && error.message) || error || "未知錯誤").trim();
}

function gitOutput(stdout) {
  return String(stdout || "").replace(/\r?\n$/, "");
}

function runGit(projectPath, args, allowedExitCodes = []) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout: gitOutput(stdout) });
        return;
      }
      if (allowedExitCodes.includes(error.code)) {
        resolve({ code: error.code, stdout: gitOutput(stdout) });
        return;
      }
      error.gitDetail = detail(error, stderr);
      reject(error);
    });
  });
}

async function captureLocalUserName(projectPath) {
  try {
    const result = await runGit(projectPath, ["config", "--local", "--get", "user.name"], [1]);
    return result.code === 0
      ? { present: true, value: result.stdout }
      : { present: false, value: null };
  } catch (error) {
    throw new Error(`Git local user.name 讀取失敗: ${error.gitDetail || error.message}`);
  }
}

async function setLocalUserName(projectPath, name) {
  if (typeof name !== "string" || !name || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Git local user.name 設定值不合法");
  }
  try {
    await runGit(projectPath, ["config", "--local", "user.name", name]);
  } catch (error) {
    throw new Error(`Git local user.name 設定失敗: ${error.gitDetail || error.message}`);
  }
}

async function restoreLocalUserName(projectPath, snapshot) {
  try {
    if (snapshot && snapshot.present === true) {
      await runGit(projectPath, ["config", "--local", "user.name", String(snapshot.value)]);
      return;
    }
    await runGit(projectPath, ["config", "--local", "--unset-all", "user.name"], [5]);
  } catch (error) {
    throw new Error(`Git local user.name 還原失敗: ${error.gitDetail || error.message}`);
  }
}

module.exports = { captureLocalUserName, restoreLocalUserName, setLocalUserName };
