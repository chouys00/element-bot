"use strict";
const assert = require("assert");
const { runTriggerPipeline } = require("../src/trigger");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const silentLogger = { log() {}, error() {} };

function rec(body) {
  return { room_id: "!r:s", sender: "@a:s", event_id: "$e", content: { body } };
}
function recIn(roomId, body) {
  return { room_id: roomId, sender: "@a:s", event_id: "$e", content: { body } };
}

(async () => {
  {
    const enqueued = [];
    const rules = [{ name: "report", keywords: ["週報"], task: "report-skill", use_llm: false }];
    await runTriggerPipeline(rec("發週報"), {
      rules,
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f1"; },
      logger: silentLogger,
    });
    ok("use_llm:false 直接觸發並入列", enqueued.length === 1 && enqueued[0].task === "report-skill");
    ok("未命中規則不該被處理", enqueued[0].rule === "report");
  }

  {
    const enqueued = [];
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x", extract: ["環境"] }];
    await runTriggerPipeline(rec("我要部署"), {
      rules,
      judgeFn: async () => ({ trigger: true, params: { 環境: "prod" } }),
      enqueueFn: (t) => { enqueued.push(t); return "f2"; },
      logger: silentLogger,
    });
    ok("LLM 觸發則入列", enqueued.length === 1);
    ok("入列任務帶 LLM 抽出的 params", enqueued[0].params.環境 === "prod");
    ok("任務含 source 訊息資訊", enqueued[0].source.body === "我要部署");
  }

  {
    const enqueued = [];
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x" }];
    await runTriggerPipeline(rec("昨天那個部署掛了"), {
      rules,
      judgeFn: async () => ({ trigger: false, params: {} }),
      enqueueFn: (t) => { enqueued.push(t); return "f3"; },
      logger: silentLogger,
    });
    ok("LLM 不觸發則不入列", enqueued.length === 0);
  }

  {
    const enqueued = [];
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x" }];
    let threwOut = false;
    try {
      await runTriggerPipeline(rec("我要部署"), {
        rules,
        judgeFn: async () => { throw new Error("API 壞了"); },
        enqueueFn: (t) => { enqueued.push(t); return "f4"; },
        logger: silentLogger,
      });
    } catch (_) { threwOut = true; }
    ok("judge 失敗不向外丟出", threwOut === false);
    ok("judge 失敗不入列", enqueued.length === 0);
  }

  // ── 房間範圍(rooms 欄位)──
  const roomScoped = (rooms) => [{ name: "色", keywords: ["改顏色"], task: "demo-skill", use_llm: false, rooms }];

  {
    const enqueued = [];
    await runTriggerPipeline(recIn("!a:s", "幫我改顏色"), {
      rules: roomScoped(["!a:s", "!b:s"]),
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("rooms 以 room_id 命中則觸發", enqueued.length === 1);
  }

  {
    const enqueued = [];
    await runTriggerPipeline(recIn("!z:s", "幫我改顏色"), {
      rules: roomScoped(["!a:s", "!b:s"]),
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("room_id 不在 rooms 清單則不觸發", enqueued.length === 0);
  }

  {
    const enqueued = [];
    await runTriggerPipeline(recIn("!a:s", "幫我改顏色"), {
      rules: roomScoped(["前端群"]), // rooms 填顯示名而非 id
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("rooms 只認 room_id,填顯示名不命中(避免撞名誤觸發)", enqueued.length === 0);
  }

  {
    const enqueued = [];
    await runTriggerPipeline(recIn("!whatever:s", "幫我改顏色"), {
      rules: roomScoped([]), // 空 rooms = 不限定
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("rooms 為空陣列視為不限定,任何房間都觸發", enqueued.length === 1);
  }

  console.log(`trigger.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
