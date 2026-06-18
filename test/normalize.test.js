"use strict";
const assert = require("assert");
const { normalize } = require("../src/normalize");

// 用假的 MatrixEvent：只實作 normalize 會呼叫的方法
function fakeEvent(over = {}) {
  const d = {
    id: "$e1", room: "!r:hs", sender: "@a:hs", ts: 12345,
    type: "m.room.message", content: { msgtype: "m.text", body: "hi" },
    ...over,
  };
  return {
    getId: () => d.id,
    getRoomId: () => d.room,
    getSender: () => d.sender,
    getTs: () => d.ts,
    getType: () => d.type,
    getContent: () => d.content,
  };
}

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed++; };

const r = normalize(fakeEvent());
ok("event_id", r.event_id === "$e1");
ok("room_id", r.room_id === "!r:hs");
ok("sender", r.sender === "@a:hs");
ok("origin_server_ts", r.origin_server_ts === 12345);
ok("type", r.type === "m.room.message");
ok("content.body", r.content.body === "hi");

console.log(`normalize.test.js: ${passed} 項通過 ✅`);
