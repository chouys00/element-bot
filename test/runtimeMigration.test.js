"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const repo = path.resolve(__dirname, "..");
const files = [
  ...filesUnder(path.join(repo, "src")),
  path.join(repo, ".env.example"),
  path.join(repo, "config", "rules.example.json"),
];

const violations = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (/claude/i.test(text)) violations.push(`${path.relative(repo, file)}: Claude runtime 命名`);
  if (/demo-skill|runCodexSync/.test(text)) violations.push(`${path.relative(repo, file)}: 已移除的正式 runtime/task 介面`);
  for (const skillPath of [".claude/skills", ".agents/skills", ".cursor/skills", ".Codex/skills"]) {
    if (text.includes(skillPath)) violations.push(`${path.relative(repo, file)}: 固定目標路徑 ${skillPath}`);
  }
}

assert.deepStrictEqual(violations, [], violations.join("\n"));
console.log(`runtimeMigration.test.js: ${files.length} 個現行檔案通過 ✅`);
