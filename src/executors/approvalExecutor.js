"use strict";
const ops = require("./ops");
const { parseTaskResult } = require("./taskResult");

function buildApprovalPrompt(event) {
  return [
    "這是一筆已完成 Dashboard 人工驗收的發布通知。",
    "請依本專案自己的 AGENTS.md、instructions、skills 與安全規則處理；element-bot 不介入專案工具體系。",
    "核准資料：",
    `task_id: ${event.task_id}`,
    `target_branch: ${event.target_branch}`,
    `approved_by: ${event.approved_by}`,
    `approved_at: ${event.approved_at}`,
    `Task 專屬 Git worktree: ${event.workspace_path}`,
    "先確認目前正位於上述 Task 專屬 worktree，且變更只屬於本 Task-ID；不得切回或提交共用 project_path 的 dirty changes。",
    "若無法唯一確認變更歸屬，回報 blocked，不得 commit 或 push。",
    "請先以 Task-ID 判斷是否已完成相同發布。若已完成，驗證後回報 success，不得重複 commit。",
    "若尚未完成，請將本任務既有變更 commit 並 push 到 target_branch。",
    "commit message 必須包含以下兩行：",
    `Task-ID: ${event.task_id}`,
    `Approved-by: ${event.approved_by}`,
    "完成後依指定 schema 回報 status 與完整 output；若無法安全完成，回報 failed 或 blocked 並說明原因。",
  ].join("\n");
}

async function approvalExecutor(event, deps = {}) {
  const runCodex = deps.runCodex || ops.runCodex;
  const stdout = await runCodex(buildApprovalPrompt(event), event.workspace_path);
  return parseTaskResult(stdout);
}

module.exports = { approvalExecutor, buildApprovalPrompt };
