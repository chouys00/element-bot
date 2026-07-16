"use strict";
const assert = require("assert");
const { formatTaskNumber } = require("../src/taskNumber");

assert.strictEqual(
  formatTaskNumber("2026-07-16T03-49-46-175Z-____-q3fnoi"),
  "20260716-114946-q3fnoi"
);
assert.strictEqual(
  formatTaskNumber("2026-12-31T18-30-05-001Z-rule-abc123"),
  "20270101-023005-abc123"
);
assert.strictEqual(formatTaskNumber("task-123"), "task-123");
assert.strictEqual(formatTaskNumber(""), "");

console.log("taskNumber.test.js: 4 項通過 ✅");
