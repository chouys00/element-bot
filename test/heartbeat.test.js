"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { isFresh, readHeartbeat, writeHeartbeat, startMatrixHeartbeat } = require("../src/heartbeat");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

ok("新鮮(剛寫)", isFresh(1000, 1500, 1000) === true);
ok("過期(超過 maxAge)", isFresh(1000, 3000, 1000) === false);
ok("非數字視為不新鮮", isFresh(null, 3000, 1000) === false);

const dir = path.join(os.tmpdir(), `hb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
writeHeartbeat(dir);
const ts = readHeartbeat(dir);
ok("寫入後讀回為數字", typeof ts === "number" && ts > 0);
ok("讀回值接近現在", Math.abs(Date.now() - ts) < 5000);
ok("缺檔回 null", readHeartbeat(path.join(dir, "nope")) === null);
fs.writeFileSync(path.join(dir, "bot-heartbeat"), "corrupt", "utf8");
ok("壞內容回 null(非 NaN)", readHeartbeat(dir) === null);

// Matrix 心跳必須反映實際 sync 狀態，不能只因 Node 程序還活著就持續顯示在線。
const client = new EventEmitter();
writeHeartbeat(dir);
const stopMatrixHeartbeat = startMatrixHeartbeat(client, dir);
ok("開始監控時清除上次程序留下的在線狀態", isFresh(readHeartbeat(dir), Date.now(), 1000) === false);

client.emit("sync", "PREPARED");
ok("首次 Matrix sync 完成後上線", isFresh(readHeartbeat(dir), Date.now(), 1000) === true);

client.emit("sync", "ERROR");
ok("Matrix sync 錯誤時立即離線", isFresh(readHeartbeat(dir), Date.now(), 1000) === false);

client.emit("sync", "SYNCING");
ok("Matrix 恢復同步後重新上線", isFresh(readHeartbeat(dir), Date.now(), 1000) === true);

client.emit("sync", "RECONNECTING");
ok("Matrix 重連期間不誤報為在線", isFresh(readHeartbeat(dir), Date.now(), 1000) === false);

stopMatrixHeartbeat();
client.emit("sync", "SYNCING");
ok("停止監控後不再更新心跳", isFresh(readHeartbeat(dir), Date.now(), 1000) === false);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`heartbeat.test.js: ${passed} 項通過 ✅`);
