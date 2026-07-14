"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../fsUtils");
const { STEPS, initState, readState, writeState, markStep } = require("./checkpoint");

const STEP_LABELS = { prepare: "檢查本體 git", ai_run: "AI 改動本體", verify: "驗證改動", summarize: "彙總結果" };

// 對 queue/logs/<id>.log append 一行 NDJSON(印完即落地)。
function appendLog(queueDir, id, obj) {
  const logsDir = ensureDir(path.join(queueDir, "logs"));
  fs.appendFileSync(path.join(logsDir, id + ".log"), JSON.stringify(obj) + "\n", "utf8");
}

// 測試/儀表板用:讀回 log 的每行 JSON(壞行略過)。
function readLogLines(queueDir, id) {
  let raw;
  try { raw = fs.readFileSync(path.join(queueDir, "logs", id + ".log"), "utf8"); }
  catch (_) { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) {}
  }
  return out;
}

// executor 主體:依檢查點跑四步,每步吐 NDJSON;已 ok 步驟跳過;任一步丟錯→標 error 並上拋。
// ctx = { queueDir, id, logger, handlers, ops }
//  - handlers:覆寫整組步驟處理器(測試用假處理器)
//  - ops:傳給預設處理器的低階操作(Task 3 注入)
async function agentExecutor(task, ctx) {
  const { queueDir, id, logger } = ctx;
  const handlers = ctx.handlers || require("./defaultHandlers").make(ctx.ops);
  const workDir = path.join(queueDir, "work", id);

  let state = readState(workDir) || initState(id);
  if (!state.steps) state.steps = {};
  state.workDir = workDir;
  state.attempt = (state.attempt || 0) + 1;
  writeState(workDir, state);

  const emit = (obj) => appendLog(queueDir, id, obj);
  emit({ steps: STEPS.map((k) => ({ key: k, label: STEP_LABELS[k] })) });

  const shared = { id, produced: [], verify: null };
  let summary = null;

  for (const step of STEPS) {
    if (state.steps[step] === "ok") { emit({ step, status: "ok", note: "略過(已完成)" }); continue; }
    const t0 = Date.now();
    try {
      emit({ step, status: "run" });
      const r = await handlers[step]({ workDir, task, emit, logger, shared });
      if (step === "summarize") summary = r;
      markStep(state, step, "ok");
      writeState(workDir, state);
      emit({ step, status: "ok", ms: Date.now() - t0 });
    } catch (err) {
      markStep(state, step, "error");
      writeState(workDir, state);
      emit({ step, status: "error", ms: Date.now() - t0, note: String((err && err.message) || err) });
      throw err; // worker 會移到 failed/;state.json 留著供重跑續跑
    }
  }
  if (summary) emit(summary);
  return summary;
}

module.exports = { agentExecutor, appendLog, readLogLines, STEP_LABELS };
