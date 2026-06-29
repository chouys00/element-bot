"use strict";
const fs = require("fs");
const path = require("path");

// 處理單一 pending 任務檔:讀取 → 移 processing/ → 執行 executor → 成功移 done/、失敗移 failed/。
// deps = { queueDir, executor(task, { logger })->Promise, logger }
// 回傳 "done" | "failed"。
async function processOne(filePath, deps) {
  const { queueDir, executor, logger } = deps;
  const processingDir = path.join(queueDir, "processing");
  const doneDir = path.join(queueDir, "done");
  const failedDir = path.join(queueDir, "failed");
  const base = path.basename(filePath);

  let task;
  try {
    task = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fs.mkdirSync(failedDir, { recursive: true });
    fs.renameSync(filePath, path.join(failedDir, base));
    logger.error(`[worker] ${base} 解析失敗 → failed/:`, err.message);
    return "failed";
  }

  // 開始執行前先移到 processing/:儀表板可顯示「進行中」,且 pollOnce 只掃 pending/ 故不會重入。
  fs.mkdirSync(processingDir, { recursive: true });
  const processingPath = path.join(processingDir, base);
  fs.renameSync(filePath, processingPath);

  try {
    await executor(task, { logger, queueDir, id: base.replace(/\.json$/, "") });
    fs.mkdirSync(doneDir, { recursive: true });
    fs.renameSync(processingPath, path.join(doneDir, base));
    logger.log(`[worker] ${base} 完成 → done/`);
    return "done";
  } catch (err) {
    fs.mkdirSync(failedDir, { recursive: true });
    const dest = path.join(failedDir, base);
    fs.renameSync(processingPath, dest);
    fs.writeFileSync(dest + ".error.txt", String((err && err.stack) || err), "utf8");
    logger.error(`[worker] ${base} 執行失敗 → failed/:`, err.message);
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

// 啟動回收:把 processing/ 內所有殘留任務搬回 pending/。
// 對應 work/<id>/state.json 仍在,重新撿起時會從斷點續跑。同時修掉「卡 processing/」的舊問題。
function recoverProcessing(queueDir, logger) {
  const processingDir = path.join(queueDir, "processing");
  const pendingDir = path.join(queueDir, "pending");
  if (!fs.existsSync(processingDir)) return 0;
  const files = fs.readdirSync(processingDir).filter((f) => f.endsWith(".json"));
  if (files.length) fs.mkdirSync(pendingDir, { recursive: true });
  let n = 0;
  for (const f of files) {
    fs.renameSync(path.join(processingDir, f), path.join(pendingDir, f));
    logger.log(`[worker] 回收中斷任務 ${f} → pending/(將從斷點續跑)`);
    n++;
  }
  return n;
}

module.exports = { processOne, pollOnce, recoverProcessing };
