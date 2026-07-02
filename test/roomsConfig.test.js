"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  readRoomsConfig,
  writeRoomsConfig,
  validateRoomsConfig,
  resolveRoomIds,
  reloadRoomIds,
  DEFAULTS,
} = require("../src/roomsConfig");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
function fresh() {
  const d = path.join(os.tmpdir(), `rc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const cfgFile = (d) => path.join(d, "rooms-config.json");

// 檔不存在 → readRoomsConfig 回預設空清單
{
  const d = fresh();
  const c = readRoomsConfig(d);
  ok("無檔回預設 room_ids 空陣列", Array.isArray(c.room_ids) && c.room_ids.length === 0);
  fs.rmSync(d, { recursive: true, force: true });
}

// 寫入合法設定後可讀回,且只保留已知欄位、去重與 trim
{
  const d = fresh();
  const saved = writeRoomsConfig(d, { room_ids: [" !a:s ", "!b:s", "!a:s", ""], 亂塞: 1 });
  ok("寫入回傳落地 room_ids", saved.room_ids.length === 2 && saved.room_ids[0] === "!a:s");
  ok("剔除未知欄位", saved.亂塞 === undefined);
  const back = readRoomsConfig(d);
  ok("讀回一致", back.room_ids.length === 2 && back.room_ids[1] === "!b:s");
  fs.rmSync(d, { recursive: true, force: true });
}

// 壞 JSON → readRoomsConfig 回預設(不丟錯)
{
  const d = fresh();
  fs.writeFileSync(cfgFile(d), "{ not json", "utf8");
  const c = readRoomsConfig(d);
  ok("壞 JSON 回預設不丟錯", Array.isArray(c.room_ids) && c.room_ids.length === 0);
  fs.rmSync(d, { recursive: true, force: true });
}

// 驗證:room_ids 非陣列 → 丟錯
{
  let threw = false;
  try { validateRoomsConfig({ room_ids: "!x:s" }); } catch (_) { threw = true; }
  ok("room_ids 非陣列應丟錯", threw === true);
}
// 驗證:room_ids 含非字串 → 丟錯
{
  let threw = false;
  try { validateRoomsConfig({ room_ids: ["!x:s", 123] }); } catch (_) { threw = true; }
  ok("room_ids 含非字串應丟錯", threw === true);
}
// 驗證:空清單為合法(允許暫時不監聽任何房間)
{
  ok("空清單合法", validateRoomsConfig({ room_ids: [] }) === true);
}

// writeRoomsConfig 非法 → 丟錯且不寫檔
{
  const d = fresh();
  let threw = false;
  try { writeRoomsConfig(d, { room_ids: "nope" }); } catch (_) { threw = true; }
  ok("非法寫入丟錯", threw === true);
  ok("非法寫入不留檔", !fs.existsSync(cfgFile(d)));
  fs.rmSync(d, { recursive: true, force: true });
}

// resolveRoomIds:檔存在且合法 → 用檔;否則 → 用 env 後備
{
  const d = fresh();
  ok("無檔回 env 後備", JSON.stringify(resolveRoomIds(d, ["!env:s"])) === JSON.stringify(["!env:s"]));
  writeRoomsConfig(d, { room_ids: ["!file:s"] });
  ok("有檔用檔內容(忽略 env)", JSON.stringify(resolveRoomIds(d, ["!env:s"])) === JSON.stringify(["!file:s"]));
  fs.rmSync(d, { recursive: true, force: true });
}
// resolveRoomIds:檔存在但為空清單 → 用檔的空清單(不回退 env,因為那是刻意清空)
{
  const d = fresh();
  writeRoomsConfig(d, { room_ids: [] });
  ok("空清單檔用空清單(不回退 env)", resolveRoomIds(d, ["!env:s"]).length === 0);
  fs.rmSync(d, { recursive: true, force: true });
}
// resolveRoomIds:檔壞掉 → 回 env 後備
{
  const d = fresh();
  fs.writeFileSync(cfgFile(d), "{ bad", "utf8");
  ok("壞檔回 env 後備", JSON.stringify(resolveRoomIds(d, ["!env:s"])) === JSON.stringify(["!env:s"]));
  fs.rmSync(d, { recursive: true, force: true });
}

// reloadRoomIds:成功回新清單;失敗(壞檔)沿用前一版
{
  const d = fresh();
  const logger = { log() {}, warn() {} };
  writeRoomsConfig(d, { room_ids: ["!new:s"] });
  ok("reload 成功回新清單", JSON.stringify(reloadRoomIds(d, ["!old:s"], logger)) === JSON.stringify(["!new:s"]));
  fs.writeFileSync(cfgFile(d), "{ broken", "utf8");
  ok("reload 壞檔沿用前一版", JSON.stringify(reloadRoomIds(d, ["!keep:s"], logger)) === JSON.stringify(["!keep:s"]));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`roomsConfig.test.js: ${passed} 項通過 ✅`);
