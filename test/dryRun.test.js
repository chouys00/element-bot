"use strict";
const assert = require("assert");
const { dryRunExecutor } = require("../src/executors/dryRun");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

(async () => {
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(" ")), error: () => {} };
  const task = { rule: "deploy", task: "deploy-skill", params: { 環境: "prod" } };

  await dryRunExecutor(task, { logger });
  ok("dry-run 有印出一行", lines.length === 1);
  ok("印出內容含 task 名", lines[0].includes("deploy-skill"));
  ok("印出內容含 params", lines[0].includes("prod"));

  console.log(`dryRun.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
