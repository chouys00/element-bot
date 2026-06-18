"use strict";

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "messages.jsonl");

// 將一筆記錄附上接收時間後,以一行 JSON 追加寫入 messages.jsonl。
function writeEvent(record) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const line = JSON.stringify({ ...record, _received_at: new Date().toISOString() });
  fs.appendFileSync(OUTPUT_FILE, line + "\n", "utf8");
}

module.exports = { writeEvent, OUTPUT_FILE };
