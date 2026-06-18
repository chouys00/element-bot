"use strict";

// 輕量測試,不依賴測試框架:`node test/handler.test.js`,全綠則 exit 0。
const assert = require("assert");
const { shouldCapture, toRecord } = require("../src/handler");

const ROOM = "!target:ims.opscloud.info";
const OTHER = "!other:ims.opscloud.info";
const START = 1000;
const opts = { roomIds: [ROOM], startTs: START };

function msg(over = {}) {
  return {
    type: "m.room.message",
    sender: "@alice:ims.opscloud.info",
    origin_server_ts: START + 100,
    event_id: "$e1",
    content: { msgtype: "m.text", body: "hello" },
    ...over,
  };
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

// shouldCapture
ok("擷取目標房間的正常訊息", shouldCapture(ROOM, msg(), opts) === true);
ok("非目標房間略過", shouldCapture(OTHER, msg(), opts) === false);
ok("非 m.room.message 略過", shouldCapture(ROOM, msg({ type: "m.reaction" }), opts) === false);
ok("無 body 略過", shouldCapture(ROOM, msg({ content: { msgtype: "m.text" } }), opts) === false);
ok("啟動前舊訊息略過", shouldCapture(ROOM, msg({ origin_server_ts: START - 1 }), opts) === false);
ok("本人帳號的訊息也擷取(不過濾 sender)", shouldCapture(ROOM, msg({ sender: "@patrick.zyx:ims.opscloud.info" }), opts) === true);
ok("沒有 ts 也擷取(不強制)", shouldCapture(ROOM, msg({ origin_server_ts: undefined }), opts) === true);

// toRecord
const r = toRecord(ROOM, msg());
ok("toRecord 帶入 room_id 參數", r.room_id === ROOM);
ok("toRecord 取出 body", r.body === "hello");
ok("toRecord 取出 msgtype", r.msgtype === "m.text");
ok("toRecord 不含 _received_at(由 writer 加)", r._received_at === undefined);

console.log(`handler.test.js: ${passed} 項通過 ✅`);
