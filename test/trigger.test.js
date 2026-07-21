"use strict";
const assert = require("assert");
const { runTriggerPipeline, dryRunRules, fillTemplate } = require("../src/trigger");

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
    const rules = [{ name: "report", keywords: ["週報"], task: "report-skill", use_llm: false, rooms: ["!r:s"] }];
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
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x", extract: ["環境"], rooms: ["!r:s"] }];
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
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x", rooms: ["!r:s"] }];
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
    const rules = [{ name: "deploy", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x", rooms: ["!r:s"] }];
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

  // ── LLM 判斷狀態紀錄(judgeStatus 注入)──
  {
    const events = [];
    const judgeStatus = {
      start: (rule) => { events.push(`start:${rule.name}`); return "jid1"; },
      finish: (id, o) => events.push(`finish:${id}:${o.result}`),
    };
    const rules = [{ name: "deploy", keywords: ["部署"], task: "d", use_llm: true, intent: "x", rooms: ["!r:s"] }];
    await runTriggerPipeline(rec("我要部署"), {
      rules, judgeFn: async () => ({ trigger: true, params: {} }),
      enqueueFn: () => "f", logger: silentLogger, judgeStatus,
    });
    ok("LLM 觸發:start → finish(triggered)", events.join(",") === "start:deploy,finish:jid1:triggered");

    events.length = 0;
    await runTriggerPipeline(rec("我要部署"), {
      rules, judgeFn: async () => ({ trigger: false, params: {} }),
      enqueueFn: () => "f", logger: silentLogger, judgeStatus,
    });
    ok("LLM 拒絕:finish(rejected)", events.join(",") === "start:deploy,finish:jid1:rejected");

    events.length = 0;
    await runTriggerPipeline(rec("我要部署"), {
      rules, judgeFn: async () => { throw new Error("CLI timeout"); },
      enqueueFn: () => "f", logger: silentLogger, judgeStatus,
    });
    ok("LLM 失敗:finish(error)", events.join(",") === "start:deploy,finish:jid1:error");
  }

  {
    // start 回 null(紀錄寫失敗)時不呼叫 finish、也不影響觸發
    const enqueued = [];
    let finished = 0;
    await runTriggerPipeline(rec("我要部署"), {
      rules: [{ name: "deploy", keywords: ["部署"], task: "d", use_llm: true, intent: "x", rooms: ["!r:s"] }],
      judgeFn: async () => ({ trigger: true, params: {} }),
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
      judgeStatus: { start: () => null, finish: () => finished++ },
    });
    ok("start 失敗(null)不呼叫 finish 且照常觸發", finished === 0 && enqueued.length === 1);
  }

  {
    // 未注入 judgeStatus(舊呼叫方式)完全不受影響
    const enqueued = [];
    await runTriggerPipeline(rec("我要部署"), {
      rules: [{ name: "deploy", keywords: ["部署"], task: "d", use_llm: true, intent: "x", rooms: ["!r:s"] }],
      judgeFn: async () => ({ trigger: true, params: {} }),
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("未注入 judgeStatus 向後相容", enqueued.length === 1);
  }

  // ── 房間範圍(rooms 欄位)──
  const roomScoped = (rooms) => [{ name: "色", keywords: ["改顏色"], task: "test-task", use_llm: false, rooms }];

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
      rules: roomScoped([]), // 空 rooms = 不觸發任何房間(規則須明確指定房間)
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("rooms 為空陣列 = 不觸發任何房間", enqueued.length === 0);
  }

  {
    const enqueued = [];
    await runTriggerPipeline(recIn("!whatever:s", "幫我改顏色"), {
      rules: [{ name: "色", keywords: ["改顏色"], task: "test-task", use_llm: false }], // 無 rooms 欄位
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("缺 rooms 欄位 = 不觸發任何房間", enqueued.length === 0);
  }

  // ── 啟用開關(enabled 欄位)──
  {
    const enqueued = [];
    await runTriggerPipeline(rec("發週報"), {
      rules: [{ name: "report", keywords: ["週報"], task: "report-skill", use_llm: false, enabled: false, rooms: ["!r:s"] }],
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("enabled:false 的規則命中關鍵字也不觸發", enqueued.length === 0);
  }

  {
    const enqueued = [];
    await runTriggerPipeline(rec("發週報"), {
      rules: [{ name: "report", keywords: ["週報"], task: "report-skill", use_llm: false, enabled: true, rooms: ["!r:s"] }],
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("enabled:true 正常觸發", enqueued.length === 1);
  }

  {
    const enqueued = [];
    await runTriggerPipeline(rec("發週報"), {
      rules: [{ name: "report", keywords: ["週報"], task: "report-skill", use_llm: false, rooms: ["!r:s"] }], // 無 enabled 欄位
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("缺 enabled 欄位視為啟用(向後相容)", enqueued.length === 1);
  }

  // ── 試跑(dryRunRules)──
  {
    const rules = [
      { name: "顏色", keywords: ["改顏色"], task: "test-task", use_llm: false, rooms: ["!z:s"] },
      { name: "部署", keywords: ["部署"], task: "deploy-skill", use_llm: true, intent: "x", rooms: ["!a:s"] },
      { name: "停用的", keywords: ["改顏色"], task: "test-task", use_llm: false, enabled: false, rooms: ["!z:s"] },
      { name: "限房間", keywords: ["改顏色"], task: "test-task", use_llm: false, rooms: ["!a:s"] },
    ];
    const res = dryRunRules("幫我改顏色", "!z:s", rules);
    const by = (n) => res.find((r) => r.name === n);
    ok("非 LLM 命中 → triggers", by("顏色").triggers === true);
    ok("LLM 命中 → 不直接 triggers 但 needs_llm", by("部署").triggers === false && by("部署").needs_llm === false); // 關鍵字未命中(訊息無「部署」)
    ok("停用規則 → 不觸發且 enabled=false", by("停用的").triggers === false && by("停用的").enabled === false);
    ok("房間不符 → 不觸發且 room_ok=false", by("限房間").triggers === false && by("限房間").room_ok === false);

    const res2 = dryRunRules("我要部署", "!a:s", rules);
    const dep = res2.find((r) => r.name === "部署");
    ok("LLM 規則關鍵字命中且過閘 → needs_llm=true、triggers=false", dep.needs_llm === true && dep.triggers === false);

    const res3 = dryRunRules("幫我改顏色", "!a:s", rules);
    ok("房間相符時限房間規則會觸發", res3.find((r) => r.name === "限房間").triggers === true);

    // roomId 未指定(UI「全部房間」):有設房間的規則不因房間被擋,聚焦關鍵字/啟用。
    const resAll = dryRunRules("幫我改顏色", undefined, rules);
    ok("全部房間:有房間的規則 room_ok=true", resAll.find((r) => r.name === "限房間").room_ok === true);
    ok("全部房間:關鍵字命中且非 LLM → 會觸發", resAll.find((r) => r.name === "限房間").triggers === true);
    ok("全部房間:停用規則仍不觸發", resAll.find((r) => r.name === "停用的").triggers === false);
    // 沒設房間的規則:即使「全部房間」也不放行(本就永遠不觸發)。
    const resNoRoom = dryRunRules("改顏色", undefined, [{ name: "無房間", keywords: ["改顏色"], task: "test-task", use_llm: false }]);
    ok("全部房間:沒設房間的規則 room_ok=false", resNoRoom[0].room_ok === false);
  }

  // ── dryRunRules 帶出 skill-dispatch 的指令/佔位/專案路徑(供試跑顯示「會送什麼」)──
  {
    const rules = [
      { name: "固定", keywords: ["啟動"], task: "skill-dispatch", project_path: "D:\\P", target_branch: "main", command: "啟動", use_llm: false, rooms: ["!a:s"] },
      { name: "帶參", keywords: ["打開"], task: "skill-dispatch", project_path: "D:\\P", target_branch: "feature/{分支}", command: "啟動 {目標}", use_llm: true, intent: "x", extract: ["目標", "分支"], rooms: ["!a:s"] },
    ];
    const res = dryRunRules("啟動", "!a:s", rules);
    const fixed = res.find((r) => r.name === "固定");
    ok("dryRun 帶出 command", fixed.command === "啟動");
    ok("固定指令 has_placeholder=false", fixed.has_placeholder === false);
    ok("dryRun 帶出 project_path", fixed.project_path === "D:\\P");
    ok("dryRun 帶出 target_branch", fixed.target_branch === "main");
    ok("dryRun 帶出 rooms", Array.isArray(fixed.rooms) && fixed.rooms[0] === "!a:s");
    const param = res.find((r) => r.name === "帶參");
    ok("帶佔位 has_placeholder=true", param.has_placeholder === true);
    ok("非 skill-dispatch 無 command 時為 null", dryRunRules("幫我改顏色", "!z:s", [{ name: "x", keywords: ["改顏色"], task: "test-task", use_llm: false, rooms: ["!z:s"] }])[0].command === null);
  }

  // ── fillTemplate:把 {佔位} 用 params 填掉(支援中文 key)──
  ok("fillTemplate 填入 params", fillTemplate("/i18n {路徑}", { 路徑: "a/b" }) === "/i18n a/b");
  ok("fillTemplate 缺參數填空字串", fillTemplate("/i18n {路徑}", {}) === "/i18n ");
  ok("fillTemplate 無佔位原樣回傳", fillTemplate("啟動", {}) === "啟動");
  ok("fillTemplate 多佔位", fillTemplate("{a}-{b}", { a: "1", b: "2" }) === "1-2");

  // ── 通用任務 skill-dispatch:帶 project_path,並用 params 填充 command ──
  {
    const enqueued = [];
    const rules = [{ name: "H5多語系", keywords: ["多語系"], task: "skill-dispatch",
      project_path: "D:\\GB\\GBH5", target_branch: "feature/{分支}", command: "/i18n {路徑}",
      use_llm: true, intent: "x", extract: ["路徑", "分支"], rooms: ["!r:s"] }];
    await runTriggerPipeline(rec("幫我把 activity 轉多語系"), {
      rules,
      judgeFn: async () => ({ trigger: true, params: { 路徑: "pages/activity", 分支: "activity" } }),
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("skill-dispatch 任務帶 project_path", enqueued[0].project_path === "D:\\GB\\GBH5");
    ok("command 用 params 填充後入列", enqueued[0].command === "/i18n pages/activity");
    ok("target_branch 用 params 填充後入列", enqueued[0].target_branch === "feature/activity");
  }

  {
    const enqueued = [];
    const rules = [{ name: "啟動H5", keywords: ["打開H5"], task: "skill-dispatch",
      project_path: "D:\\GB\\GBH5", target_branch: "main", command: "啟動", use_llm: false, rooms: ["!r:s"] }];
    await runTriggerPipeline(rec("幫我打開H5"), {
      rules,
      judgeFn: async () => { throw new Error("不該被呼叫"); },
      enqueueFn: (t) => { enqueued.push(t); return "f"; },
      logger: silentLogger,
    });
    ok("固定 command(無佔位)原樣帶入", enqueued[0].command === "啟動");
  }

  console.log(`trigger.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
