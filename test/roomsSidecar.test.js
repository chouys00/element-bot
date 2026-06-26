"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeRoomsSidecar, readRoomsMap, translateRoom, buildRoomEntries } = require("../src/roomsSidecar");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

const dir = path.join(os.tmpdir(), `rs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
writeRoomsSidecar(dir, { "!a:s": "產品群", "!b:s": "維運告警" });
const map = readRoomsMap(dir);
ok("寫入後讀回正確", map["!a:s"] === "產品群" && map["!b:s"] === "維運告警");
ok("缺檔回空物件", Object.keys(readRoomsMap(path.join(dir, "nope"))).length === 0);

ok("有名稱用名稱", translateRoom("!a:s", map) === "產品群");
ok("無名稱回退 room_id", translateRoom("!zzz:s", map) === "!zzz:s");
ok("空 map 回退 room_id", translateRoom("!a:s", {}) === "!a:s");

const fakeClient = { getRoom: (id) => (id === "!a:s" ? { name: "產品群" } : null) };
const entries = buildRoomEntries(fakeClient, ["!a:s", "!b:s"]);
ok("client 有名稱用名稱", entries["!a:s"] === "產品群");
ok("client 無名稱回退 id", entries["!b:s"] === "!b:s");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`roomsSidecar.test.js: ${passed} 項通過 ✅`);
