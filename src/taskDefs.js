"use strict";
const path = require("path");

// 每個 skill 一筆任務定義。新增 skill = 在此加一筆,不動 worker/bot/dashboard。
// 介面:
//   sourceDir(task) -> 來源站點絕對路徑(會被複製成隔離副本)
//   prompt(task)    -> 餵給 claude -p 的無人值守指示
//   artifacts       -> 預期產物(相對 copy 根);全部存在則 ai_run 跳過 claude
//   verifyArgs(copyDir) -> ["py","-3",script,copyDir,locale] 之類;null=不 verify
//   needsReview     -> 完成後要人補/核對的提示
const FTL_ROOT = process.env.NSL_FTL_ROOT || "D:/ftl/ftl/ftl";
const I18N_SKILL_DIR = process.env.NSL_SKILL_DIR || path.join(FTL_ROOT, ".cursor/skills/template-i18n-inject");

const DEFS = {
  "i18n-skill": {
    sourceDir: (task) => path.join(FTL_ROOT, String((task.params && task.params["站點"]) || "")),
    prompt: () => [
      "你是無人值守的自動執行者,必須全自動完成,禁止發問或停下來等待確認。",
      "所有原需使用者確認/Plan 同意/對照表確認/dry-run 確認的環節,一律自動採用文件建議做法並續行。",
      "站點目錄就是你的當前工作目錄,所有產出與修改只能發生在此目錄(及其子目錄)內。",
      "請完整讀取並嚴格遵照 " + I18N_SKILL_DIR + "/SKILL.md 及其 reference/ 全部,",
      "依 SKILL.md 自行判斷單/多語系,把中文文案轉成 data-i18n 標記、產生 i18n/<語系>.json。",
      "安全紅線:只准讀寫當前工作目錄(及其子目錄);不可修改當前目錄以外任何檔案。產完翻譯檔即可,不需自行 verify。",
    ].join(""),
    artifacts: ["i18n/zh_CN.json"],
    verifyArgs: (copyDir) => [process.env.NSL_PY || "py", "-3", path.join(I18N_SKILL_DIR, "scripts", "verify_i18n.py"), copyDir, "zh_CN"],
    needsReview: ["請人工核對文案正確性(verify 只驗結構不驗文意)", "套用到正式站前再次確認"],
  },
};

function getTaskDef(name) {
  const def = DEFS[name];
  if (!def) throw new Error("查無任務定義:" + name);
  return def;
}

module.exports = { getTaskDef, DEFS };
