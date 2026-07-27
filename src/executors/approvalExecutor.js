"use strict";
const ops = require("./ops");

function buildApprovalPrompt(event) {
  const message = event.message || "提交代碼";
  return [
    "這是一則由 Dashboard 驗收後送出的專案通知。",
    `通知內容：${message}`,
    "",
    "請依目標專案本身的 AGENTS.md、instructions、skills 與既有流程處理。",
    "element-bot 只負責把此訊息送達，不等待或判定後續處理結果。",
    "",
    `task_id: ${event.task_id}`,
    `target_branch: ${event.target_branch}`,
    `approved_by: ${event.approved_by}`,
    `approved_at: ${event.approved_at}`,
    `project_path: ${event.project_path}`,
  ].join("\n");
}

async function approvalExecutor(event, deps = {}) {
  const runCodex = deps.runCodex || ops.runCodex;
  const stdout = await runCodex(buildApprovalPrompt(event), event.project_path);
  return { delivered: true, output: String(stdout || "") };
}

module.exports = { approvalExecutor, buildApprovalPrompt };
