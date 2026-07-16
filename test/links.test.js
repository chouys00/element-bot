"use strict";
const assert = require("assert");
const { extractHttpLinks } = require("../src/links");

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; }

assert.deepStrictEqual(
  extractHttpLinks("互動驗收 https://preview.intra.local/tasks/task-1/；報告 http://10.0.0.2:4173/"),
  ["https://preview.intra.local/tasks/task-1/", "http://10.0.0.2:4173/"]
);
passed++;

assert.deepStrictEqual(
  extractHttpLinks("https://preview.intra.local/tasks/task-1/ https://preview.intra.local/tasks/task-1/"),
  ["https://preview.intra.local/tasks/task-1/"]
);
passed++;

assert.deepStrictEqual(extractHttpLinks("javascript:alert(1) file:///secret ftp://example.com"), []);
passed++;

ok("空值回傳空陣列", Array.isArray(extractHttpLinks()) && extractHttpLinks().length === 0);

console.log(`links.test.js: ${passed} 項通過 ✅`);
