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

// writeNotifyFile:成功任務從 log 撈 summary,寫 notify/<id>.json
{
  const q = freshQueue();
  const id = "t1";
  fs.mkdirSync(path.join(q, "logs"), { recursive: true });
  fs.writeFileSync(path.join(q, "logs", id + ".log"),
    `{"step":"summarize","status":"ok"}\n{"status":"OK","summary":"產出 result.json,verify errors=0"}\n`, "utf8");
  const task = { rule: "週報", task: "report-skill", source: { room_id: "!r:s", sender: "@a:s", body: "發週報" } };
  const p = writeNotifyFile({ queueDir: q, id, status: "done", task });
  ok("成功摘要取自 log", p.summary === "產出 result.json,verify errors=0");
  ok("payload 帶 rule", p.rule === "週報");
  ok("payload 帶 source", p.source.room_id === "!r:s");
  ok("notify 檔已落地", fs.existsSync(path.join(q, "notify", id + ".json")));
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
    { "!r:s": "產品群" }
  );
  ok("成功含 ✅", text.startsWith("✅"));
  ok("含規則名", text.includes("週報"));
  ok("房間名已翻譯", text.includes("產品群"));
  ok("發送者縮短為 localpart", text.includes("@alice") && !text.includes("@alice:s"));
  ok("摘要在第二行", text.split("\n")[1] === "已產出報表");
}

// formatNotify:失敗 + 無摘要 → 單行
{
  const text = formatNotify({ status: "failed", rule: "部署", source: { room_id: "!r:s" }, summary: "" }, {});
  ok("失敗含 ❌", text.startsWith("❌"));
  ok("房間名 fallback 用 id", text.includes("!r:s"));
  ok("無摘要則單行", !text.includes("\n"));
}

// formatNotify:無 rule 用 task 名;source 缺房間 → 未知房間
{
  const text = formatNotify({ status: "done", task: "some-skill", source: {}, summary: "" }, {});
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
