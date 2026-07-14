"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const setupPath = path.join(root, ".agents", "skills", "setup-deploy-env", "SKILL.md");
const switchPath = path.join(root, ".agents", "skills", "switch-matrix-account", "SKILL.md");
const agentsPath = path.join(root, "AGENTS.md");

for (const file of [setupPath, switchPath, agentsPath]) {
  assert.ok(fs.existsSync(file), `缺少 repository instruction: ${path.relative(root, file)}`);
}

for (const skillPath of [setupPath, switchPath]) {
  const text = fs.readFileSync(skillPath, "utf8");
  assert.match(text, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---/s, `${skillPath} frontmatter 無效`);
}

const setup = fs.readFileSync(setupPath, "utf8");
assert.match(setup, /codex .*exec/i, "setup skill 必須使用 codex exec 驗證");
assert.doesNotMatch(setup, /Codex -p|claude -p/i, "setup skill 不得使用其他 CLI 的 prompt 語法");
for (const forbidden of [".claude/skills", ".agents/skills", ".cursor/skills", ".Codex/skills"]) {
  assert.ok(!setup.includes(forbidden), `setup skill 不得檢查目標 skill 目錄: ${forbidden}`);
}

const agents = fs.readFileSync(agentsPath, "utf8");
assert.match(agents, /繁體中文/, "AGENTS.md 必須保存語言偏好");
assert.match(agents, /src\/codexRunner\.js/, "AGENTS.md 必須記錄唯一 runtime 邊界");
assert.match(agents, /不得修改.*目標專案/s, "AGENTS.md 必須記錄目標專案邊界");

console.log("repositoryInstructions.test.js: repository instructions 通過 ✅");
