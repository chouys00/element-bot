"use strict";
const path = require("path");
const { readJsonSafe, writeJsonAtomic } = require("../fsUtils");

const STEPS = ["prepare", "ai_run", "verify", "summarize"];

function statePath(workDir) {
  return path.join(workDir, "state.json");
}

// 初始 state:全部步驟 pending。
function initState(id) {
  const steps = {};
  for (const k of STEPS) steps[k] = "pending";
  return { id, steps, workDir: null, attempt: 0, updated_at: new Date().toISOString() };
}

// 讀 state.json;不存在或損毀回 null(視為無檢查點 → 從頭重跑)。
function readState(workDir) {
  return readJsonSafe(statePath(workDir), null);
}

// 原子寫:先寫 .tmp 再 rename,確保任何時點中斷都有完整檔。
function writeState(workDir, state) {
  state.updated_at = new Date().toISOString();
  return writeJsonAtomic(statePath(workDir), state);
}

// 回傳第一個非 ok 的步驟;全部 ok 回 null。
function nextStep(state) {
  for (const k of STEPS) {
    if (!state.steps || state.steps[k] !== "ok") return k;
  }
  return null;
}

// 標記某步驟狀態(pending|ok|error)。
function markStep(state, step, status) {
  if (!state.steps) state.steps = {};
  state.steps[step] = status;
  return state;
}

module.exports = { STEPS, statePath, initState, readState, writeState, nextStep, markStep };
