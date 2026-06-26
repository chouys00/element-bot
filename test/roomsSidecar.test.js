"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeRoomsSidecar, readRoomsMap, translateRoom, buildRoomEntries, mergeRoomEntries, collectQueueRoomIds, resolveRoomNames } = require("../src/roomsSidecar");

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

// --- mergeRoomEntries ---
ok("merge: 合併兩邊的鍵", JSON.stringify(mergeRoomEntries({ "!a:s": "甲" }, { "!b:s": "乙" })) === JSON.stringify({ "!a:s": "甲", "!b:s": "乙" }));
ok("merge: fresh 真名覆蓋舊值", mergeRoomEntries({ "!a:s": "舊" }, { "!a:s": "新" })["!a:s"] === "新");
ok("merge: 不把真名降級成 id 回退", mergeRoomEntries({ "!a:s": "甲" }, { "!a:s": "!a:s" })["!a:s"] === "甲");
ok("merge: 既有缺值時用 id 補上(維持鍵存在)", mergeRoomEntries({}, { "!a:s": "!a:s" })["!a:s"] === "!a:s");

// --- collectQueueRoomIds ---
const qroot = path.join(os.tmpdir(), `qr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
for (const s of ["pending", "done", "failed"]) fs.mkdirSync(path.join(qroot, s), { recursive: true });
fs.writeFileSync(path.join(qroot, "pending", "1.json"), JSON.stringify({ source: { room_id: "!a:s" } }), "utf8");
fs.writeFileSync(path.join(qroot, "done", "2.json"), JSON.stringify({ source: { room_id: "!a:s" } }), "utf8"); // 重複
fs.writeFileSync(path.join(qroot, "done", "3.json"), JSON.stringify({ source: { room_id: "!b:s" } }), "utf8");
fs.writeFileSync(path.join(qroot, "failed", "bad.json"), "{ not json", "utf8"); // 容錯
const qids = collectQueueRoomIds(qroot).sort();
ok("collectQueueRoomIds 去重且容錯", qids.length === 2 && qids[0] === "!a:s" && qids[1] === "!b:s");
fs.rmSync(qroot, { recursive: true, force: true });

(async () => {
  // --- resolveRoomNames ---
  const client = {
    getRoom: (id) => (id === "!synced:s" ? { name: "已同步房" } : null),
    getStateEvent: async (id) => {
      if (id === "!state:s") return { name: "狀態查到房" };
      throw new Error("not found");
    },
  };
  const resolved = await resolveRoomNames(client, ["!synced:s", "!state:s", "!gone:s"]);
  ok("resolve: getRoom 拿到名稱", resolved["!synced:s"] === "已同步房");
  ok("resolve: getStateEvent 補名稱", resolved["!state:s"] === "狀態查到房");
  ok("resolve: 都查不到回退 id", resolved["!gone:s"] === "!gone:s");

  console.log(`roomsSidecar.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
