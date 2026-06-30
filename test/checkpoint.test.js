"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { STEPS, initState, readState, writeState, nextStep, markStep } = require("../src/executors/checkpoint");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshWork() {
  const d = path.join(os.tmpdir(), `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

{
  const s = initState("abc");
  ok("初始所有步驟 pending", STEPS.every((k) => s.steps[k] === "pending"));
  ok("初始 nextStep 為第一步", nextStep(s) === STEPS[0]);
  ok("帶 id", s.id === "abc");
}
{
  const s = initState("abc");
  markStep(s, "prepare", "ok");
  ok("標記後跳到下一步", nextStep(s) === "ai_run");
  STEPS.forEach((k) => markStep(s, k, "ok"));
  ok("全完成 nextStep 為 null", nextStep(s) === null);
}
{
  const d = freshWork();
  ok("不存在回 null", readState(d) === null);
  const s = initState("xyz");
  writeState(d, s);
  const back = readState(d);
  ok("寫回讀得到", back && back.id === "xyz");
  ok("有 updated_at", typeof back.updated_at === "string");
  fs.writeFileSync(path.join(d, "state.json"), "{ broken", "utf8");
  ok("損毀回 null", readState(d) === null);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`checkpoint.test.js: ${passed} 項通過 ✅`);
