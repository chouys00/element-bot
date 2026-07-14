"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { processNotifyFile, drainNotifyDir } = require("../src/notifySender");
const { writeNotifyConfig } = require("../src/notifyConfig");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
const silentLogger = { log() {}, error() {} };

function fresh() {
  const root = path.join(os.tmpdir(), `ns-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const queueDir = path.join(root, "queue");
  const storageDir = path.join(root, "storage");
  fs.mkdirSync(path.join(queueDir, "notify"), { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  return { root, queueDir, storageDir };
}
function writeNotify(queueDir, id, payload) {
  const p = path.join(queueDir, "notify", id + ".json");
  fs.writeFileSync(p, JSON.stringify(payload), "utf8");
  return p;
}

(async () => {
  // 啟用 → 發送並刪檔
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!notify:s" });
    const f = writeNotify(queueDir, "t1", { status: "done", rule: "週報", source: { room_id: "!r:s", sender: "@a" }, summary: "ok" });
    const sent = [];
    const r = await processNotifyFile(f, { storageDir, sendFn: async (room, text) => sent.push({ room, text }), logger: silentLogger });
    ok("啟用時回 sent", r === "sent");
    ok("送到設定房間", sent.length === 1 && sent[0].room === "!notify:s");
    ok("訊息含規則名", sent[0].text.includes("週報"));
    ok("發送後刪檔", !fs.existsSync(f));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // resolveSender 提供顯示名 → 訊息用顯示名而非帳號
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!notify:s" });
    const f = writeNotify(queueDir, "disp", { status: "done", rule: "週報", source: { room_id: "!r:s", sender: "@patrick.zyx:ims" }, summary: "" });
    const sent = [];
    const r = await processNotifyFile(f, {
      storageDir,
      sendFn: async (room, text) => sent.push(text),
      resolveSender: async (roomId, userId) => (roomId === "!r:s" && userId === "@patrick.zyx:ims" ? "Patrick.He.t" : null),
      logger: silentLogger,
    });
    ok("resolveSender 命中回 sent", r === "sent");
    ok("訊息用顯示名", sent[0].includes("Patrick.He.t"));
    ok("訊息不出現帳號", !sent[0].includes("@patrick.zyx"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // resolveSender 回 null(查不到)→ 退回帳號 localpart,且不因此丟錯
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!notify:s" });
    const f = writeNotify(queueDir, "nodisp", { status: "done", rule: "週報", source: { room_id: "!r:s", sender: "@patrick.zyx:ims" }, summary: "" });
    const sent = [];
    const r = await processNotifyFile(f, {
      storageDir,
      sendFn: async (room, text) => sent.push(text),
      resolveSender: async () => { throw new Error("member 未載入"); },
      logger: silentLogger,
    });
    ok("resolveSender 丟錯不影響發送", r === "sent");
    ok("退回帳號 localpart", sent[0].includes("@patrick.zyx"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // 停用 → 不發送但仍刪檔(認領)
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: false });
    const f = writeNotify(queueDir, "t2", { status: "done", rule: "x", source: {} });
    let called = 0;
    const r = await processNotifyFile(f, { storageDir, sendFn: async () => { called++; }, logger: silentLogger });
    ok("停用回 skipped", r === "skipped");
    ok("停用不呼叫 sendFn", called === 0);
    ok("停用仍刪檔", !fs.existsSync(f));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // failed_only:成功任務不發、失敗任務發
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!n:s", notify_on: "failed_only" });
    const sent = [];
    const send = async (room, text) => sent.push(text);
    const fa = writeNotify(queueDir, "okrun", { status: "done", rule: "a", source: {} });
    const ra = await processNotifyFile(fa, { storageDir, sendFn: send, logger: silentLogger });
    ok("failed_only 下成功任務 skipped", ra === "skipped" && sent.length === 0);
    const fb = writeNotify(queueDir, "badrun", { status: "failed", rule: "b", source: {} });
    const rb = await processNotifyFile(fb, { storageDir, sendFn: send, logger: silentLogger });
    ok("failed_only 下失敗任務 sent", rb === "sent" && sent.length === 1);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // 壞 JSON → bad,且刪檔避免卡住
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!n:s" });
    const f = path.join(queueDir, "notify", "bad.json");
    fs.writeFileSync(f, "{ not json", "utf8");
    const r = await processNotifyFile(f, { storageDir, sendFn: async () => {}, logger: silentLogger });
    ok("壞 JSON 回 bad", r === "bad");
    ok("壞 JSON 已刪(不卡佇列)", !fs.existsSync(f));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // 發送失敗 → error(sendFn 丟錯不外拋)
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!n:s" });
    const f = writeNotify(queueDir, "t5", { status: "done", rule: "x", source: {} });
    let threw = false;
    let r;
    try { r = await processNotifyFile(f, { storageDir, sendFn: async () => { throw new Error("network down"); }, logger: silentLogger }); }
    catch (_) { threw = true; }
    ok("發送失敗不外拋", threw === false);
    ok("發送失敗回 error", r === "error");
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // drainNotifyDir:批次處理啟動時殘留
  {
    const { root, queueDir, storageDir } = fresh();
    writeNotifyConfig(storageDir, { enabled: true, room_id: "!n:s" });
    writeNotify(queueDir, "d1", { status: "done", rule: "a", source: {} });
    writeNotify(queueDir, "d2", { status: "failed", rule: "b", source: {} });
    let n = 0;
    const cnt = await drainNotifyDir(queueDir, { storageDir, sendFn: async () => { n++; }, logger: silentLogger });
    ok("drain 回處理筆數 2", cnt === 2);
    ok("drain 全部發送", n === 2);
    ok("drain 後目錄清空", fs.readdirSync(path.join(queueDir, "notify")).length === 0);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // drainNotifyDir:目錄不存在 → 0(不丟錯)
  {
    const { root, storageDir } = fresh();
    const cnt = await drainNotifyDir(path.join(root, "nope"), { storageDir, sendFn: async () => {}, logger: silentLogger });
    ok("無目錄回 0", cnt === 0);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  console.log(`notifySender.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
