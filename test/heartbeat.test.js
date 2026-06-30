"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isFresh, readHeartbeat, writeHeartbeat } = require("../src/heartbeat");

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
fs.rmSync(dir, { recursive: true, force: true });

console.log(`heartbeat.test.js: ${passed} 項通過 ✅`);
