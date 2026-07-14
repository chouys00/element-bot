"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/dashboard/server");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

(async () => {
  const root = path.join(os.tmpdir(), `dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const queueDir = path.join(root, "queue");
  const storageDir = path.join(root, "storage");
  const outputFile = path.join(root, "output", "messages.jsonl");
  for (const s of ["pending", "done"]) fs.mkdirSync(path.join(queueDir, s), { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  fs.writeFileSync(path.join(storageDir, "rooms.json"), JSON.stringify({ "!r:s": "產品群" }), "utf8");
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), String(Date.now()), "utf8");
  fs.writeFileSync(path.join(queueDir, "done", "t1.json"), JSON.stringify({ rule: "會議", task: "cal", enqueued_at: "2026-06-26T01:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "hi", event_id: "$1" } }), "utf8");
  fs.appendFileSync(outputFile, JSON.stringify({ room_id: "!r:s", sender: "@a", body: "hello" }) + "\n", "utf8");

  const rulesPath = path.join(root, "rules.json");
  fs.writeFileSync(rulesPath, JSON.stringify([{ name: "改顏色", keywords: ["改顏色"], task: "skill-dispatch", project_path: root, command: "把背景改成紅色", use_llm: false }]), "utf8");

  // 假 judge:body 含「觸發」→ trigger true 並抽出固定連結,否則 trigger false。供 /api/rules/judge 測試,不打真 Codex。
  const fakeJudge = async (_rule, body) => ({ trigger: String(body).includes("觸發"), params: { 連結: "https://example.com/x" } });
  const server = createServer({ queueDir, storageDir, outputFile, rulesPath, envRoomIds: ["!env:s"], judgeFn: fakeJudge });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  ok("tasks 回一筆", tasks.length === 1);
  ok("狀態 done", tasks[0].status === "done");
  ok("房間名稱翻譯", tasks[0].room_name === "產品群");

  const status = await (await fetch(`${base}/api/status`)).json();
  ok("bot 線上", status.bot_online === true);
  ok("done 計數 1", status.counts.done === 1);

  const msgs = await (await fetch(`${base}/api/messages`)).json();
  ok("messages 一筆", msgs.length === 1 && msgs[0].body === "hello");
  ok("messages 房間名稱已翻譯", msgs[0].room_name === "產品群");

  const log = await (await fetch(`${base}/api/tasks/t1/log`)).json();
  ok("日誌占位", log.source === "none");

  const html = await fetch(`${base}/`);
  ok("根路徑回 200", html.status === 200);

  const traversal = await fetch(`${base}/api/tasks/..%2F..%2Fsecret/log`);
  ok("log 端點擋路徑穿越(400)", traversal.status === 400);

  // POST requeue:failed/<id>.json → pending/<id>.json
  fs.mkdirSync(path.join(queueDir, "failed"), { recursive: true });
  fs.writeFileSync(path.join(queueDir, "failed", "r1.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  fs.writeFileSync(path.join(queueDir, "failed", "r1.json.error.txt"), "boom", "utf8");
  const rq = await fetch(`${base}/api/tasks/r1/requeue`, { method: "POST" });
  ok("requeue 回 200", rq.status === 200);
  ok("已移回 pending/", fs.existsSync(path.join(queueDir, "pending", "r1.json")));
  ok("failed/ 任務已無", !fs.existsSync(path.join(queueDir, "failed", "r1.json")));
  ok("error.txt 已清", !fs.existsSync(path.join(queueDir, "failed", "r1.json.error.txt")));

  // POST verify:寫 work/<id>/verified.json
  fs.writeFileSync(path.join(queueDir, "done", "v1.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const vf = await fetch(`${base}/api/tasks/v1/verify`, { method: "POST" });
  ok("verify 回 200", vf.status === 200);
  ok("有 verified 標記", fs.existsSync(path.join(queueDir, "work", "v1", "verified.json")));

  // verify 不存在的任務 → 404
  const vno = await fetch(`${base}/api/tasks/ghost/verify`, { method: "POST" });
  ok("verify 無此任務 → 404", vno.status === 404);

  // open 路徑逸出 work/ → 400(openPath 在 work/ 外,spawn 前就被擋下)
  fs.mkdirSync(path.join(queueDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(queueDir, "logs", "o1.log"), JSON.stringify({ status: "OK", summary: "x", openPath: "C:/evil/x" }) + "\n", "utf8");
  const op = await fetch(`${base}/api/tasks/o1/open`, { method: "POST" });
  ok("open 路徑逸出 work/ → 400", op.status === 400);

  // POST 防穿越:id 帶 .. → 400
  const badPost = await fetch(`${base}/api/tasks/..%2Fx/requeue`, { method: "POST" });
  ok("穿越 POST id 擋下", badPost.status === 400);

  // requeue 不存在的 failed 任務 → 404
  const noFail = await fetch(`${base}/api/tasks/nope/requeue`, { method: "POST" });
  ok("requeue 無此 failed → 404", noFail.status === 404);

  // GET /api/rules → { rules, rooms, tasks }
  const rd = await (await fetch(`${base}/api/rules`)).json();
  ok("rules GET 回現有規則", Array.isArray(rd.rules) && rd.rules.length === 1 && rd.rules[0].name === "改顏色");
  ok("rules GET 附房間 id→名", rd.rooms["!r:s"] === "產品群");
  ok("rules GET 附 task 名單", Array.isArray(rd.tasks) && rd.tasks.length === 1 && rd.tasks[0] === "skill-dispatch");
  ok("rules GET 附監聽清單(檔缺 → env 後備)", Array.isArray(rd.monitor_rooms) && rd.monitor_rooms[0] === "!env:s");

  // PUT /api/rules 合法 → 寫入並可讀回
  const put = await fetch(`${base}/api/rules`, {
    method: "PUT",
    body: JSON.stringify([{ name: "新規則", keywords: ["x"], task: "skill-dispatch", project_path: root, command: "x", use_llm: false, rooms: ["!r:s"] }]),
  });
  ok("rules PUT 合法回 200", put.status === 200);
  const after = await (await fetch(`${base}/api/rules`)).json();
  ok("rules PUT 已落地", after.rules.length === 1 && after.rules[0].name === "新規則");
  ok("rules PUT 保留 rooms", after.rules[0].rooms[0] === "!r:s");

  // PUT 非法規則 → 400,且原檔不被覆寫
  const badPut = await fetch(`${base}/api/rules`, { method: "PUT", body: JSON.stringify([{ name: "" }]) });
  ok("rules PUT 非法回 400", badPut.status === 400);
  const stillThere = await (await fetch(`${base}/api/rules`)).json();
  ok("rules PUT 非法不覆寫原檔", stillThere.rules.length === 1 && stillThere.rules[0].name === "新規則");

  // PUT 壞 JSON → 400
  const badJson = await fetch(`${base}/api/rules`, { method: "PUT", body: "{not json" });
  ok("rules PUT 壞 JSON 回 400", badJson.status === 400);

  // POST /api/rules/dry-run:回報每條規則是否命中(此時檔案內容為前面 PUT 的「新規則」keywords:["x"], rooms:["!r:s"])
  const dry1 = await (await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: JSON.stringify({ body: "含有 x 的訊息", room_id: "!r:s" }) })).json();
  ok("dry-run 回 results 陣列", Array.isArray(dry1.results) && dry1.results.length === 1);
  ok("dry-run 命中且房間相符 → triggers", dry1.results[0].keyword_hit === true && dry1.results[0].triggers === true);

  const dry2 = await (await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: JSON.stringify({ body: "含有 x 的訊息", room_id: "!other:s" }) })).json();
  ok("dry-run 房間不符 → 不觸發", dry2.results[0].room_ok === false && dry2.results[0].triggers === false);

  const dry3 = await (await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: JSON.stringify({ body: "完全不相關" }) })).json();
  ok("dry-run 關鍵字未命中 → 不觸發", dry3.results[0].keyword_hit === false && dry3.results[0].triggers === false);

  const dryBad = await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: "{not json" });
  ok("dry-run 壞 JSON 回 400", dryBad.status === 400);

  // POST /api/rules/judge:只跑 LLM 二次判斷(注入假 judge),回傳 trigger + 抽取 params。dry-run 之後前端逐條背景呼叫用。
  await fetch(`${base}/api/rules`, {
    method: "PUT",
    body: JSON.stringify([
      { name: "LLM規則", keywords: ["x"], task: "skill-dispatch", project_path: root, command: "{連結}", use_llm: true, intent: "測試意圖", extract: ["連結"], rooms: ["!r:s"] },
      { name: "非LLM規則", keywords: ["y"], task: "skill-dispatch", project_path: root, command: "y", use_llm: false, rooms: ["!r:s"] },
    ]),
  });
  const jTrig = await (await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 0, body: "請觸發這則" }) })).json();
  ok("judge use_llm 規則 → trigger true", jTrig.trigger === true);
  ok("judge 回抽取參數", jTrig.params && jTrig.params["連結"] === "https://example.com/x");

  const jNo = await (await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 0, body: "普通訊息" }) })).json();
  ok("judge 不含觸發字 → trigger false", jNo.trigger === false);

  const jSkip = await (await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 1, body: "y" }) })).json();
  ok("judge 非 use_llm 規則 → skipped", jSkip.skipped === true);

  const jNF = await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 99, body: "x" }) });
  ok("judge 無此規則 → 404", jNF.status === 404);

  const jBad = await fetch(`${base}/api/rules/judge`, { method: "POST", body: "{not json" });
  ok("judge 壞 JSON → 400", jBad.status === 400);

  // GET /api/notify-config → 預設(停用)+ 房間清單
  const nc0 = await (await fetch(`${base}/api/notify-config`)).json();
  ok("notify-config GET 預設停用", nc0.config.enabled === false);
  ok("notify-config GET 附房間 id→名", nc0.rooms["!r:s"] === "產品群");

  // PUT 合法 → 落地並可讀回
  const ncPut = await fetch(`${base}/api/notify-config`, { method: "PUT", body: JSON.stringify({ enabled: true, room_id: "!r:s", notify_on: "all" }) });
  ok("notify-config PUT 合法回 200", ncPut.status === 200);
  const nc1 = await (await fetch(`${base}/api/notify-config`)).json();
  ok("notify-config PUT 已落地", nc1.config.enabled === true && nc1.config.room_id === "!r:s");

  // PUT 非法(啟用卻沒房間)→ 400,且不覆寫原檔
  const ncBad = await fetch(`${base}/api/notify-config`, { method: "PUT", body: JSON.stringify({ enabled: true, room_id: "" }) });
  ok("notify-config PUT 非法回 400", ncBad.status === 400);
  const nc2 = await (await fetch(`${base}/api/notify-config`)).json();
  ok("notify-config PUT 非法不覆寫", nc2.config.room_id === "!r:s");

  // PUT 壞 JSON → 400
  const ncJson = await fetch(`${base}/api/notify-config`, { method: "PUT", body: "{not json" });
  ok("notify-config PUT 壞 JSON 回 400", ncJson.status === 400);

  // GET /api/rooms-config → 檔缺回 env 後備 + 房間名映射
  const rc0 = await (await fetch(`${base}/api/rooms-config`)).json();
  ok("rooms-config GET 檔缺回 env 後備", Array.isArray(rc0.room_ids) && rc0.room_ids[0] === "!env:s");
  ok("rooms-config GET 附房間 id→名", rc0.rooms["!r:s"] === "產品群");

  // PUT 合法 → 落地(正規化去重),之後 GET 用檔而非 env,且 /api/rules monitor_rooms 同步
  const rcPut = await fetch(`${base}/api/rooms-config`, { method: "PUT", body: JSON.stringify({ room_ids: [" !r:s ", "!x:s", "!r:s"] }) });
  ok("rooms-config PUT 合法回 200", rcPut.status === 200);
  const rc1 = await (await fetch(`${base}/api/rooms-config`)).json();
  ok("rooms-config PUT 已落地並去重/trim", rc1.room_ids.length === 2 && rc1.room_ids[0] === "!r:s" && rc1.room_ids[1] === "!x:s");
  const rulesAfterRc = await (await fetch(`${base}/api/rules`)).json();
  ok("rules monitor_rooms 反映存檔後清單", rulesAfterRc.monitor_rooms.length === 2 && rulesAfterRc.monitor_rooms[1] === "!x:s");

  // PUT 非法(room_ids 非陣列)→ 400,且不覆寫原檔
  const rcBad = await fetch(`${base}/api/rooms-config`, { method: "PUT", body: JSON.stringify({ room_ids: "nope" }) });
  ok("rooms-config PUT 非法回 400", rcBad.status === 400);
  const rc2 = await (await fetch(`${base}/api/rooms-config`)).json();
  ok("rooms-config PUT 非法不覆寫", rc2.room_ids.length === 2 && rc2.room_ids[0] === "!r:s");

  // PUT 壞 JSON → 400
  const rcJson = await fetch(`${base}/api/rooms-config`, { method: "PUT", body: "{not json" });
  ok("rooms-config PUT 壞 JSON 回 400", rcJson.status === 400);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`dashboardServer.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
