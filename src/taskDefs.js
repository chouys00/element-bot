"use strict";
const os = require("os");
const path = require("path");

// 每個 skill 一筆任務定義。新增 skill = 在此加一筆,不動 worker/bot/dashboard。
// 介面:
//   sourceDir(task) -> 來源站點/專案絕對路徑(會被複製成隔離副本)
//   prompt(task)    -> 餵給 claude -p 的無人值守指示(叫 claude 進副本讀該專案的 SKILL.md 並執行)
//   artifacts       -> 預期產物(相對 copy 根);全部存在則 ai_run 跳過
//   verifyArgs(copyDir) -> ["py","-3",script,copyDir,locale] 之類;null=不 verify
//   needsReview     -> 完成後要人補/核對的提示
// const FTL_ROOT = process.env.NSL_FTL_ROOT || "D:/ftl/ftl/ftl";
const FTL_ROOT = process.env.NSL_FTL_ROOT || "D:/GB/PC/ftl/ftl";
const I18N_SKILL_DIR = process.env.NSL_SKILL_DIR || path.join(FTL_ROOT, ".cursor/skills/template-i18n-inject");

// demo-skill 用:本地專案根目錄(預設放系統暫存區,避免汙染 repo / 巢狀 git)。
const DEMO_ROOT = process.env.NSL_DEMO_ROOT || path.join(os.tmpdir(), "element-bot-demo");

const DEFS = {
  "i18n-skill": {
    sourceDir: (task) => {
      const site = String((task.params && task.params["站點"]) || "");
      const resolved = path.resolve(FTL_ROOT, site);
      const root = path.resolve(FTL_ROOT);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error("站點路徑逸出 FTL_ROOT:" + site);
      }
      return resolved;
    },
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

  // 示範「目標專案自帶 SKILL.md、由 claude 讀後執行」的 skill。
  // element-bot 不持有 skill 邏輯:只把 claude 帶進專案副本,叫它讀 ./SKILL.md 並照做。
  // 目標專案(sample-app)是個全白前端,其 SKILL.md 指示「把背景改成使用者要的顏色 + 寫 result.json」。
  // verifyArgs:null 故跳過外部 verify;result.json 是專案 SKILL 產出的完成標記。
  "demo-skill": {
    sourceDir: (task) => {
      const proj = String((task.params && task.params["專案"]) || "sample-app");
      const resolved = path.resolve(DEMO_ROOT, proj);
      const root = path.resolve(DEMO_ROOT);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error("專案路徑逸出 DEMO_ROOT:" + proj);
      }
      return resolved;
    },
    prompt: (task) => {
      const instruction = String((task && task.source && task.source.body) || "把背景改成淡藍色");
      return [
        "你是無人值守的自動執行者,必須全自動完成,禁止發問或停下來等待確認。",
        "你的當前工作目錄就是一個前端專案的副本,所有讀寫只能發生在此目錄(及其子目錄)內。",
        "請完整讀取當前目錄的 SKILL.md,並嚴格依照其指示完成這次任務。",
        "使用者透過聊天室下達的指令是:「" + instruction + "」。",
        "安全紅線:只准讀寫當前工作目錄(及其子目錄),不可碰此目錄以外任何檔案。",
      ].join("");
    },
    artifacts: ["result.json"],
    verifyArgs: null,
    needsReview: ["確認背景色是否如預期(開 index.html 檢視)", "正式套用前再次確認"],
  },
};

function getTaskDef(name) {
  const def = DEFS[name];
  if (!def) throw new Error("查無任務定義:" + name);
  return def;
}

module.exports = { getTaskDef, DEFS };
