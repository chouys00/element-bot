"use strict";
const { runCodex } = require("./codexRunner");
const { judge } = require("./judge");
const { fillTemplate } = require("./trigger");

// 派 Codex 以唯讀模式進入專案，確認分派內容與預計流程，不判斷目標專案的 skill 體系。
function runProbe(projectDir, command, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const runner = opts.runner || defaultRunner;
  const prompt = [
    "【這是連通測試，不是真的任務】以下是使用者透過聊天室下達、預計要在本專案執行的指令。",
    "請只回報、不執行：不要真的執行流程、不要修改任何檔案、不要 git add/commit。",
    "請回報三件事：1) 目前工作目錄；2) 收到的指令原文；3) 根據目標專案自身的 instructions 與可用 skills，預計採用的處理流程。",
    "指令原文:「" + command + "」",
  ].join("\n");
  return runner(prompt, projectDir, timeoutMs);
}

async function defaultRunner(prompt, projectDir, timeoutMs) {
  try {
    const output = await runCodex(prompt, { mode: "probe", cwd: projectDir, timeoutMs });
    return { ok: true, output: output.trim() };
  } catch (error) {
    return { ok: false, output: String((error && error.message) || error) };
  }
}

// 完整探測流程：(use_llm 才) judge 抽參 → fillTemplate 填指令 → Codex 唯讀探測。
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
