"use strict";
const os = require("os");
const path = require("path");

// 每個 skill 一筆任務定義。新增 skill = 在此加一筆,不動 worker/bot/dashboard。
// 介面:
//   sourceDir(task) -> 來源站點/專案絕對路徑(會被複製成隔離副本)
//   run(copyDir, task) -> (選填)本地動作;有提供則 ai_run 執行它而非 claude
//   prompt(task)    -> 餵給 claude -p 的無人值守指示(無 run 時用)
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

  // 模擬「對本地專案做修改 → 完成通知」的測試 skill:不需 claude/Python/外部資源。
  // 走 run() hook(本地動作),產出 result.json;verifyArgs:null 故跳過 Python verify。
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
    run: require("./skills/demoModify").run,
    artifacts: ["result.json"],
    verifyArgs: null,
    needsReview: ["確認模擬改動內容是否正確", "正式套用前再次確認"],
  },
};

function getTaskDef(name) {
  const def = DEFS[name];
  if (!def) throw new Error("查無任務定義:" + name);
  return def;
}

module.exports = { getTaskDef, DEFS };
