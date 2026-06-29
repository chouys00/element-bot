"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseProgress } = require("../src/dashboard/aggregate");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshQueue() {
  const d = path.join(os.tmpdir(), `pg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(d, "logs"), { recursive: true });
  return d;
}
function writeLog(q, id, lines) {
  fs.writeFileSync(path.join(q, "logs", id + ".log"), lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
}

{
  const q = freshQueue();
  writeLog(q, "j1", [
    { steps: [{ key: "prepare", label: "準備隔離副本" }, { key: "ai_run", label: "AI 產生產物" }] },
    { step: "prepare", status: "run" },
    { step: "prepare", status: "ok", ms: 120 },
    { step: "ai_run", status: "run" },
    { step: "ai_run", status: "error", ms: 50, note: "boom" },
  ]);
  const p = parseProgress(q, "j1");
  ok("解析出兩步", p.steps.length === 2);
  ok("prepare 取最後狀態 ok", p.steps[0].status === "ok" && p.steps[0].ms === 120);
  ok("ai_run 取最後狀態 error", p.steps[1].status === "error" && p.steps[1].note === "boom");
  ok("尚無總結", p.summary === null);
  fs.rmSync(q, { recursive: true, force: true });
}
{
  const q = freshQueue();
  writeLog(q, "j2", [
    { steps: [{ key: "summarize", label: "彙總結果" }] },
    { step: "summarize", status: "ok", ms: 5 },
    { status: "OK", summary: "好了", needsReview: ["補設計"], openPath: "/x" },
  ]);
  const p = parseProgress(q, "j2");
  ok("取到總結", p.summary && p.summary.status === "OK");
  ok("needsReview 帶出", p.summary.needsReview[0] === "補設計");
  fs.rmSync(q, { recursive: true, force: true });
}
{
  const q = freshQueue();
  const p = parseProgress(q, "none");
  ok("無 log 回空進度", p.steps.length === 0 && p.summary === null);
  fs.rmSync(q, { recursive: true, force: true });
}

console.log(`progress.test.js: ${passed} 項通過 ✅`);
