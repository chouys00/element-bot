"use strict";
const assert = require("assert");
const { extractHttpLinks, extractAcceptanceLinks } = require("../src/links");

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

assert.deepStrictEqual(
  extractAcceptanceLinks([
    "已將下載連結從 https://2998app.com/ 改為 https://223.26.61.181:2998/。",
    "",
    "驗收連結：",
    "- http://192.168.168.186:53001/artifacts/task-123/banner.png",
    "- https://test.example.com/",
  ].join("\n")),
  ["http://192.168.168.186:53001/artifacts/task-123/banner.png", "https://test.example.com/"]
);
passed++;

assert.deepStrictEqual(
  extractAcceptanceLinks("已完成，請參考 https://zentao.gbboss.com/bug-view-74901.html。"),
  []
);
passed++;

ok("空值回傳空陣列", Array.isArray(extractHttpLinks()) && extractHttpLinks().length === 0);

console.log(`links.test.js: ${passed} 項通過 ✅`);
