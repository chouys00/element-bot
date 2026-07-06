"use strict";
const { spawn } = require("child_process");
const { judge } = require("./judge");
const { fillTemplate } = require("./trigger");

// 派 headless claude「唯讀」進專案:回報收到什麼指令、會用哪個 skill、大致做什麼,
// 但明確要求不執行、不改檔、不 commit。供試跑的「實跑連通測試」確認 ④(專案收到什麼)用。
function runProbe(projectDir, command, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const runner = opts.runner || defaultRunner;
  const prompt = [
    "【這是連通測試,不是真的任務】以下是使用者透過聊天室下達、預計要在本專案執行的指令。",
    "請『只回報、不執行』:不要真的執行流程、不要修改任何檔案、不要 git add/commit。",
    "請回報三件事:1) 你目前的工作目錄;2) 你收到的指令原文;3) 你會用本專案的哪個 skill(.claude/skills)來處理、大致會做什麼。",
    "指令原文:「" + command + "」",
  ].join("\n");
  return runner(prompt, projectDir, timeoutMs);
}

// 用非阻塞 spawn(非 spawnSync):dashboard 是單程序,同步阻塞會凍住整個服務。
function defaultRunner(prompt, projectDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--dangerously-skip-permissions", "-p"], {
      cwd: projectDir,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error(`探測逾時(${timeoutMs}ms)`)); }, timeoutMs);
    child.on("error", (err) => finish(reject, err));
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      const out = stdout + (stderr ? "\n[stderr] " + stderr.slice(0, 300) : "");
      finish(resolve, { ok: code === 0, output: out.trim() });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 完整探測流程:(use_llm 才) judge 抽參 → fillTemplate 填指令 → claude 唯讀探測。
// deps 可注入 judgeFn / probeFn 以利測試。回傳 { trigger, params, rendered_command, probe }。
async function probeRule(rule, body, deps = {}) {
  const judgeFn = deps.judgeFn || ((r, b) => judge(r, b));
  const probeFn = deps.probeFn || ((dir, cmd) => runProbe(dir, cmd));
  let trigger = true;
  let params = {};
  if (rule.use_llm) {
    const j = await judgeFn(rule, body);
    trigger = !!(j && j.trigger === true);
    params = (j && j.params) || {};
  }
  const rendered_command = fillTemplate(rule.command || "", params);
  if (!trigger) return { trigger: false, params, rendered_command, probe: null };
  const probe = await probeFn(rule.project_path, rendered_command);
  return { trigger: true, params, rendered_command, probe };
}

module.exports = { runProbe, probeRule };
