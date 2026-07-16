"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeNotifyFile, formatNotify, lifecycleMessage, truncate, shortSender } = require("../src/notify");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
function freshQueue() {
  const d = path.join(os.tmpdir(), `nf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// writeNotifyFile:成功任務從 log 撈 generic output,寫 notify/<id>.json
{
  const q = freshQueue();
  const id = "t1";
  fs.mkdirSync(path.join(q, "logs"), { recursive: true });
  fs.writeFileSync(path.join(q, "logs", id + ".log"),
    `{"step":"summarize","status":"ok"}\n{"status":"success","output":"產出 result.json,verify errors=0"}\n`, "utf8");
  const task = { rule: "週報", task: "report-skill", source: { room_id: "!r:s", sender: "@a:s", body: "發週報" } };
  const p = writeNotifyFile({ queueDir: q, id, status: "done", task });
  ok("成功摘要取自 log", p.summary === "產出 result.json,verify errors=0");
  ok("payload 帶 rule", p.rule === "週報");
  ok("payload 帶 source", p.source.room_id === "!r:s");
  ok("notify 檔已落地", fs.existsSync(path.join(q, "notify", id + ".json")));
  fs.rmSync(q, { recursive: true, force: true });
}

// 舊 summary 不再是現行通知契約。
{
  const q = freshQueue();
  fs.mkdirSync(path.join(q, "logs"), { recursive: true });
  fs.writeFileSync(path.join(q, "logs", "legacy.log"),
    '{"status":"OK","summary":"舊格式摘要"}\n', "utf8");
  const payload = writeNotifyFile({ queueDir: q, id: "legacy", status: "done", task: { rule: "舊任務", source: {} } });
  ok("通知忽略 legacy summary", payload.summary === "");
  fs.rmSync(q, { recursive: true, force: true });
}

// writeNotifyFile:失敗任務用 error(截斷)
{
  const q = freshQueue();
  const longErr = "x".repeat(500);
  const p = writeNotifyFile({ queueDir: q, id: "t2", status: "failed", task: { rule: "部署", task: "deploy-skill", source: {} }, error: longErr });
  ok("失敗狀態", p.status === "failed");
  ok("失敗摘要為截斷的 error", p.summary.length < 500 && p.summary.endsWith("…"));
  fs.rmSync(q, { recursive: true, force: true });
}

// writeNotifyFile:成功但無 log → summary 空字串(不丟錯)
{
  const q = freshQueue();
  const p = writeNotifyFile({ queueDir: q, id: "t3", status: "done", task: { rule: "x", task: "y", source: {} } });
  ok("無 log 時 summary 為空", p.summary === "");
  fs.rmSync(q, { recursive: true, force: true });
}

// formatNotify:範本 B — 成功,房間名翻譯 + 發送者 + 摘要第二行
{
  const text = formatNotify(
    { status: "done", rule: "週報", task: "report-skill", source: { room_id: "!r:s", sender: "@alice:s" }, summary: "已產出報表" },
    { rooms: { "!r:s": "產品群" } }
  );
  const lines = text.split("\n");
  ok("首行為狀態+規則", lines[0] === "✅「週報」完成");
  ok("房間名獨立成行,帶「聊天室」標籤", lines.some((l) => l === "聊天室:產品群"));
  ok("無顯示名時發送者縮短為 localpart,帶「觸發人」標籤", lines.some((l) => l === "觸發人:@alice") && !text.includes("@alice:s"));
  ok("摘要獨立成行(📝)", lines.some((l) => l === "📝 已產出報表"));
}

// formatNotify:提供 senderName → 用顯示名而非帳號
{
  const text = formatNotify(
    { status: "done", rule: "週報", source: { room_id: "!r:s", sender: "@alice:s" }, summary: "" },
    { rooms: {}, senderName: "Patrick.He.t" }
  );
  ok("有顯示名則用顯示名", text.includes("Patrick.He.t"));
  ok("有顯示名則不出現帳號 localpart", !text.includes("@alice"));
}

// formatNotify:失敗 + 無摘要 → 無 📝 行、無「觸發人」行(此例無 sender)
{
  const text = formatNotify({ status: "failed", rule: "部署", source: { room_id: "!r:s" }, summary: "" }, { rooms: {} });
  ok("失敗含 ❌", text.startsWith("❌"));
  ok("房間名 fallback 用 id", text.includes("聊天室:!r:s"));
  ok("無摘要則無 📝 行", !text.includes("📝"));
  ok("無 sender 則無「觸發人」行", !text.includes("觸發人"));
}

{
  const blocked = formatNotify({ status: "blocked", rule: "禪道", source: {}, summary: "登入失效" });
  const review = formatNotify({ status: "review", rule: "禪道", source: {}, summary: "部分完成" });
  ok("blocked 通知使用受阻圖示與文字", blocked.startsWith("⛔") && blocked.includes("受阻"));
  ok("review 通知使用部分完成圖示與文字", review.startsWith("⚠️") && review.includes("部分完成"));
}

{
  const q = freshQueue();
  fs.mkdirSync(path.join(q, "logs"), { recursive: true });
  fs.writeFileSync(path.join(q, "logs", "blocked.log"), '{"status":"blocked","output":"缺少登入"}\n', "utf8");
  const payload = writeNotifyFile({ queueDir: q, id: "blocked", status: "blocked", task: { rule: "禪道", source: {} } });
  ok("非成功狀態也從 output 取得摘要", payload.summary === "缺少登入");
  fs.rmSync(q, { recursive: true, force: true });
}

{
  const q = freshQueue();
  fs.mkdirSync(path.join(q, "logs"), { recursive: true });
  fs.writeFileSync(path.join(q, "logs", "generic.log"),
    JSON.stringify({ status: "success", output: "已完成；外部記錄 123。" }) + "\n", "utf8");
  const payload = writeNotifyFile({ queueDir: q, id: "generic", status: "done", task: { rule: "通用任務", source: {} } });
  ok("generic 通知使用完整 output", payload.summary === "已完成；外部記錄 123。");
  fs.rmSync(q, { recursive: true, force: true });
}

// formatNotify:無 rule 用 task 名;source 缺房間 → 未知房間;無參數也不丟錯
{
  const text = formatNotify({ status: "done", task: "some-skill", source: {}, summary: "" });
  ok("無 rule 退回 task 名", text.includes("some-skill"));
  ok("缺房間顯示未知房間", text.includes("未知房間"));
}

// shortSender
{
  ok("縮短完整 Matrix id", shortSender("@patrick.zyx:ims.opscloud.info") === "@patrick.zyx");
  ok("無冒號原樣回傳", shortSender("@bob") === "@bob");
  ok("空值不丟錯", shortSender(undefined) === "");
}

// lifecycleMessage
{
  ok("online 訊息", lifecycleMessage("online").includes("上線"));
  ok("offline 訊息", lifecycleMessage("offline").includes("下線"));
}

// truncate
{
  ok("短字串不動", truncate("abc", 10) === "abc");
  ok("長字串截斷加省略號", truncate("abcdef", 3).endsWith("…"));
}

console.log(`notify.test.js: ${passed} 項通過 ✅`);
