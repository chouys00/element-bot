"use strict";
const fs = require("fs");
const path = require("path");

// 把一筆任務寫進 <queueDir>/pending/ 下的唯一檔名 JSON。回傳寫入的完整路徑。
function enqueueTask(queueDir, task) {
  const pendingDir = path.join(queueDir, "pending");
  fs.mkdirSync(pendingDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const safeRule = String(task.rule || "rule").replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = path.join(pendingDir, `${ts}-${safeRule}-${rand}.json`);
  fs.writeFileSync(file, JSON.stringify(task, null, 2), "utf8");
  return file;
}

module.exports = { enqueueTask };
