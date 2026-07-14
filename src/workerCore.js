"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./fsUtils");
const { readState } = require("./executors/checkpoint");

// 崩潰重試保險:一個任務被回收重跑的最大嘗試次數。超過即放棄自動重試、送 failed/。
// state.attempt 由 agentExecutor 每次開跑時 +1,故硬崩潰(worker 程序死掉)也會被計入,避免無限重撿。
const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.MAX_TASK_ATTEMPTS || "3", 10);

// 任務結束後發通知(可選)。deps.notify 不存在則略過;通知失敗不影響佇列。
async function safeNotify(deps, info) {
  if (!deps.notify) return;
  try {
    await deps.notify(info);
  } catch (e) {
    if (deps.logger) deps.logger.error("[worker] 寫任務通知失敗(不影響佇列):", e.message);
  }
}

// 處理單一 pending 任務檔:讀取 → 移 processing/ → 執行 executor → 成功移 done/、失敗移 failed/。
// deps = { queueDir, executor(task, { logger })->Promise, logger, notify?(info)->Promise }
// 回傳 "done" | "failed" | "blocked" | "review"。
async function processOne(filePath, deps) {
  const { queueDir, executor, logger } = deps;
  const processingDir = path.join(queueDir, "processing");
  const failedDir = path.join(queueDir, "failed");
  const base = path.basename(filePath);

  let task;
  try {
    task = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    ensureDir(failedDir);
    fs.renameSync(filePath, path.join(failedDir, base));
    logger.error(`[worker] ${base} 解析失敗 → failed/:`, err.message);
    return "failed";
  }

  // 開始執行前先移到 processing/:儀表板可顯示「進行中」,且 pollOnce 只掃 pending/ 故不會重入。
  ensureDir(processingDir);
  const processingPath = path.join(processingDir, base);
  fs.renameSync(filePath, processingPath);

  const id = base.replace(/\.json$/, "");
  try {
    const result = await executor(task, { logger, queueDir, id });
    const status = result && result.queueStatus ? result.queueStatus : "done";
    if (!["done", "failed", "blocked", "review"].includes(status)) {
      throw new Error(`未知的任務結果狀態:${status}`);
    }
    const destDir = ensureDir(path.join(queueDir, status));
    fs.renameSync(processingPath, path.join(destDir, base));
    logger.log(`[worker] ${base} 執行結束 → ${status}/`);
    await safeNotify(deps, { queueDir, id, status, task, result });
    return status;
  } catch (err) {
    ensureDir(failedDir);
    const dest = path.join(failedDir, base);
    fs.renameSync(processingPath, dest);
    fs.writeFileSync(dest + ".error.txt", String((err && err.stack) || err), "utf8");
    logger.error(`[worker] ${base} 執行失敗 → failed/:`, err.message);
    await safeNotify(deps, { queueDir, id, status: "failed", task, error: (err && err.message) || String(err) });
    return "failed";
  }
}

// 掃描 pending/ 一輪,逐筆 processOne。回傳處理筆數。
// 注意:只掃 pending/。若程序在任務搬到 processing/ 後、搬到 done/failed/ 前崩潰,
// 該檔會卡在 processing/ 不會被自動回收(儀表板會一直顯示「進行中」),需人工處理。
async function pollOnce(deps) {
  const { queueDir } = deps;
  const pendingDir = path.join(queueDir, "pending");
  if (!fs.existsSync(pendingDir)) return 0;
  const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")).sort();
  let n = 0;
  for (const f of files) {
    await processOne(path.join(pendingDir, f), deps);
    n++;
  }
  return n;
}

// 啟動回收:把 processing/ 內殘留任務搬回 pending/,重新撿起時會從 work/<id>/state.json 斷點續跑。
// 崩潰重試保險:若某任務的 state.attempt 已達 maxAttempts 仍卡在 processing/(代表每次跑都讓 worker
// 硬崩潰或卡死),不再回收重撿,改送 failed/ 交人工,避免「崩潰→回收→再崩潰」無限迴圈。
// 回傳搬回 pending/ 的筆數(相容既有呼叫);另記 dead-letter 於 log。
function recoverProcessing(queueDir, logger, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const processingDir = path.join(queueDir, "processing");
  const pendingDir = path.join(queueDir, "pending");
  const failedDir = path.join(queueDir, "failed");
  if (!fs.existsSync(processingDir)) return 0;
  const files = fs.readdirSync(processingDir).filter((f) => f.endsWith(".json"));
  let recovered = 0;
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    const state = readState(path.join(queueDir, "work", id));
    const attempt = (state && state.attempt) || 0;
    if (attempt >= maxAttempts) {
      ensureDir(failedDir);
      const dest = path.join(failedDir, f);
      fs.renameSync(path.join(processingDir, f), dest);
      fs.writeFileSync(dest + ".error.txt", `崩潰重試保險:已嘗試 ${attempt} 次仍未完成(每次都中斷),放棄自動重試,移入 failed/ 待人工處理。`, "utf8");
      logger.error(`[worker] ${f} 已嘗試 ${attempt} 次仍中斷 → failed/(放棄自動重試,上限 ${maxAttempts})`);
      continue;
    }
    ensureDir(pendingDir);
    fs.renameSync(path.join(processingDir, f), path.join(pendingDir, f));
    logger.log(`[worker] 回收中斷任務 ${f}(已嘗試 ${attempt} 次) → pending/(將從斷點續跑)`);
    recovered++;
  }
  return recovered;
}

module.exports = { processOne, pollOnce, recoverProcessing };
