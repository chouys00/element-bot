"use strict";
const fs = require("fs");

// 檢查 skill-dispatch 的目標路徑是否存在且為目錄(供試跑的「專案健檢」用,零 AI 成本)。
// 回報格式：{ exists, directory, detail }；existsFn / statFn 可注入以利測試。
function projectCheck(projectPath, opts = {}) {
  const p = String(projectPath || "");
  if (!p) return { exists: false, directory: false, detail: "未指定專案路徑" };
  const existsFn = opts.existsFn || ((x) => fs.existsSync(x));
  if (!existsFn(p)) return { exists: false, directory: false, detail: "路徑不存在" };
  const statFn = opts.statFn || ((x) => fs.statSync(x));
  let directory = false;
  try { directory = !!statFn(p).isDirectory(); }
  catch (error) { return { exists: true, directory: false, detail: `無法讀取路徑: ${error.message}` }; }
  if (!directory) return { exists: true, directory: false, detail: "路徑存在但不是目錄" };
  return { exists: true, directory: true, detail: "路徑存在且是目錄" };
}

module.exports = { projectCheck };
