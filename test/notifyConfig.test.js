"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readNotifyConfig, writeNotifyConfig, validateNotifyConfig, DEFAULTS } = require("../src/notifyConfig");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
function fresh() {
  const d = path.join(os.tmpdir(), `nc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 檔不存在 → 回預設(停用)
{
  const d = fresh();
  const c = readNotifyConfig(d);
  ok("無檔回預設 enabled=false", c.enabled === false);
  ok("無檔回預設 room_id 空", c.room_id === "");
  ok("預設 notify_on=all", c.notify_on === "all");
  fs.rmSync(d, { recursive: true, force: true });
}

// 寫入合法設定後可讀回,且只保留已知欄位
{
  const d = fresh();
  const saved = writeNotifyConfig(d, { enabled: true, room_id: "!x:s", notify_on: "all", 亂塞: 1 });
  ok("寫入回傳落地設定", saved.room_id === "!x:s" && saved.enabled === true);
  ok("剔除未知欄位", saved.亂塞 === undefined);
  const back = readNotifyConfig(d);
  ok("讀回一致", back.enabled === true && back.room_id === "!x:s");
  fs.rmSync(d, { recursive: true, force: true });
}

// 壞 JSON → 回預設(不丟錯)
{
  const d = fresh();
  fs.writeFileSync(path.join(d, "notify-config.json"), "{ not json", "utf8");
  const c = readNotifyConfig(d);
  ok("壞 JSON 回預設不丟錯", c.enabled === false && c.notify_on === "all");
  fs.rmSync(d, { recursive: true, force: true });
}

// 驗證:啟用卻沒房間 → 丟錯
{
  let threw = false;
  try { validateNotifyConfig({ enabled: true, room_id: "" }); } catch (_) { threw = true; }
  ok("啟用但無房間應丟錯", threw === true);
}
// 驗證:enabled 非布林 → 丟錯
{
  let threw = false;
  try { validateNotifyConfig({ enabled: "yes", room_id: "!x:s" }); } catch (_) { threw = true; }
  ok("enabled 非布林應丟錯", threw === true);
}
// 驗證:notify_on 非法值 → 丟錯
{
  let threw = false;
  try { validateNotifyConfig({ enabled: false, notify_on: "sometimes" }); } catch (_) { threw = true; }
  ok("notify_on 非法值應丟錯", threw === true);
}
// 驗證:停用時可不填房間
{
  ok("停用時不填房間為合法", validateNotifyConfig({ enabled: false }) === true);
}

// writeNotifyConfig 非法 → 丟錯且不寫檔
{
  const d = fresh();
  let threw = false;
  try { writeNotifyConfig(d, { enabled: true, room_id: "" }); } catch (_) { threw = true; }
  ok("非法寫入丟錯", threw === true);
  ok("非法寫入不留檔", !fs.existsSync(path.join(d, "notify-config.json")));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`notifyConfig.test.js: ${passed} 項通過 ✅`);
