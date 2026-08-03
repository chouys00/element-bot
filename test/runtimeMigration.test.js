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
const envExample = fs.readFileSync(path.join(repo, ".env.example"), "utf8");
const migrationDoc = fs.readFileSync(path.join(repo, "docs", "codex-runtime-migration.md"), "utf8");
assert.doesNotMatch(envExample, /TASK_RESULT_MODE/);
assert.doesNotMatch(migrationDoc, /TASK_RESULT_MODE|legacy/);
assert.match(migrationDoc, /execute[\s\S]*danger-full-access/);

const files = [
  ...filesUnder(path.join(repo, "src")),
  path.join(repo, ".env.example"),
  path.join(repo, "config", "rules.example.json"),
];

const agentLaunchFiles = filesUnder(path.join(repo, "src"))
  .filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return /CODEX_COMMAND/.test(text) ||
      /(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*["'`](?:codex|cursor|claude|gemini|aider)["'`]/i.test(text);
  })
  .map((file) => path.relative(repo, file).replace(/\\/g, "/"));
assert.deepStrictEqual(agentLaunchFiles, ["src/codexRunner.js"]);

const gitLaunchFiles = filesUnder(path.join(repo, "src"))
  .filter((file) =>
    /(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*["'`]git["'`]/i.test(
      fs.readFileSync(file, "utf8"),
    ))
  .map((file) => path.relative(repo, file).replace(/\\/g, "/"));
assert.deepStrictEqual(
  gitLaunchFiles,
  ["src/approvalGitIdentity.js", "src/projectGitGate.js"],
  `只有唯讀 Git 起跑閘門與驗收身分模組可啟動 Git: ${gitLaunchFiles.join(", ")}`,
);
const approvalGitIdentity = fs.readFileSync(path.join(repo, "src", "approvalGitIdentity.js"), "utf8");
assert.match(approvalGitIdentity, /\["config", "--local"/);
assert.doesNotMatch(approvalGitIdentity, /["'`](?:add|commit|push|reset|checkout)["'`]/i);

const violations = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (/TASK_RESULT_MODE/.test(text)) violations.push(`${path.relative(repo, file)}: 舊結果模式切換殘留`);
  if (/\bCursor(?:\s+(?:runtime|CLI|agent)|\.exe)/i.test(text)) {
    violations.push(`${path.relative(repo, file)}: Cursor runtime 殘留`);
  }
  if (/claude/i.test(text)) violations.push(`${path.relative(repo, file)}: Claude runtime 殘留`);
  if (/gemini/i.test(text)) violations.push(`${path.relative(repo, file)}: Gemini runtime 殘留`);
  if (/aider/i.test(text)) violations.push(`${path.relative(repo, file)}: Aider runtime 殘留`);
  if (/demo-skill|runCodexSync/.test(text)) violations.push(`${path.relative(repo, file)}: 已移除的正式 runtime/task 殘留`);
  for (const skillPath of [".claude/skills", ".agents/skills", ".cursor/skills", ".Codex/skills"]) {
    if (text.includes(skillPath)) violations.push(`${path.relative(repo, file)}: 硬編碼目標 skill 路徑 ${skillPath}`);
  }
}

assert.deepStrictEqual(violations, [], violations.join("\n"));
console.log(`runtimeMigration.test.js: ${files.length} 個現行檔案 runtime 邊界通過 ✅`);
