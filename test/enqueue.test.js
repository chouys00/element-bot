"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { enqueueTask } = require("../src/enqueue");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const queueDir = path.join(os.tmpdir(), `queue-test-${Date.now()}`);
const task = { rule: "deploy", task: "deploy-skill", params: { 環境: "prod" } };

const file = enqueueTask(queueDir, task);
ok("回傳路徑存在", fs.existsSync(file));
ok("檔案落在 pending 目錄", path.dirname(file) === path.join(queueDir, "pending"));
ok("副檔名為 .json", file.endsWith(".json"));

const readBack = JSON.parse(fs.readFileSync(file, "utf8"));
ok("內容可往返", readBack.rule === "deploy" && readBack.params.環境 === "prod");

const file2 = enqueueTask(queueDir, task);
ok("連續入列產生不同檔名", file !== file2);

fs.rmSync(queueDir, { recursive: true, force: true });
console.log(`enqueue.test.js: ${passed} 項通過 ✅`);
