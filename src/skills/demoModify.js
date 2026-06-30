"use strict";
const fs = require("fs");
const path = require("path");

// 模擬 skill:對「本地專案」做一筆可見的修改,完成後留下 result.json 當產物/通知依據。
// 只動隔離副本(copyDir),不碰正本(正本由 prepare 的 gitClean 安全網 + copyTree 保護)。
// 介面與 claude 路徑對等:被 ai_run 步驟呼叫,簽名 run(copyDir, task)。
// 不需 claude / Python / 外部資源,純本地檔案動作,用來端到端驗證整條 executor 管線。
async function run(copyDir, task) {
  const params = (task && task.params) || {};
  const source = (task && task.source) || {};
  const desc = String(params["改動"] || source.body || "示範改動");
  const stamp = new Date().toISOString();

  // 1) 對專案做一筆可見改動:在 CHANGELOG.md 追加一行(沒有就建立)。
  const changelog = path.join(copyDir, "CHANGELOG.md");
  const line = `- ${stamp} ${desc}\n`;
  fs.appendFileSync(changelog, fs.existsSync(changelog) ? line : `# 變更紀錄\n${line}`, "utf8");

  // 2) 寫產物 result.json:summarize 會挑它當 produced,dashboard 顯示「完成通知」。
  const result = { modified: ["CHANGELOG.md"], at: stamp, note: desc };
  fs.writeFileSync(path.join(copyDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
}

module.exports = { run };
