"use strict";
const ops = require("./ops");
const { isCodexSessionId } = require("../codexSessionStore");

function buildApprovalPrompt(event) {
  const message = event.message || "提交代碼並推送";
  const approvedBy = JSON.stringify(event.approved_by);
  const lines = [
    "這是一則由 Dashboard 驗收後送出的專案通知。",
    `通知內容：${message}`,
    "",
    "element-bot 已於此專案暫時執行：",
    `git config --local user.name ${approvedBy}`,
    "請依目標專案本身的 AGENTS.md、instructions、skills 與既有流程產生 commit message、提交代碼並推送（push）。",
    "Codex 結束後，element-bot 會還原此專案原本的 local user.name。",
    "Codex 結束後，element-bot 會以唯讀 Git 查詢驗證遠端分支，不會自行 add、commit 或 push。",
    "",
    `task_id: ${event.task_id}`,
    `target_branch: ${event.target_branch}`,
    `approved_by: ${event.approved_by}`,
    `approved_at: ${event.approved_at}`,
    `project_path: ${event.project_path}`,
  ];
  if ((event.attempt || 0) > 1) {
    lines.splice(9, 0,
      "這是人工觸發的重試。請先檢查目前狀態；已有本任務 commit 時沿用它並只補推送，不得建立內容相同的重複 commit。尚未建立 commit 時才完成提交與推送。",
    );
  }
  return lines.join("\n");
}

async function approvalExecutor(event, deps = {}) {
  if (!isCodexSessionId(event && event.codex_session_id)) {
    throw new Error("找不到原始 Codex session，請重新執行任務後再驗收");
  }
  const runCodex = deps.runCodex || ops.runCodex;
  const result = await runCodex(buildApprovalPrompt(event), event.project_path, {
    resumeSessionId: event.codex_session_id,
  });
  if (result && typeof result === "object" &&
      result.sessionId && result.sessionId !== event.codex_session_id) {
    throw new Error("Codex resume 回報的 session ID 不一致");
  }
  const output = result && typeof result === "object" ? result.output : result;
  return { delivered: true, output: String(output || "") };
}

module.exports = { approvalExecutor, buildApprovalPrompt };
