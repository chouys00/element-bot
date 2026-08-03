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
assert.match(setup, /codex login status/i, "setup skill 必須以登入狀態驗證認證方式");
assert.match(setup, /OpenAI OpCo, LLC/, "setup skill 必須驗證 Windows OpenAI 數位簽章");
assert.doesNotMatch(setup, /claude|cursor/i, "setup skill 不得提供其他 agent fallback");
assert.doesNotMatch(setup, /Codex -p|claude -p/i, "setup skill 不得使用其他 CLI 的 prompt 語法");
for (const forbidden of [".claude/skills", ".agents/skills", ".cursor/skills", ".Codex/skills"]) {
  assert.ok(!setup.includes(forbidden), `setup skill 不得檢查目標 skill 目錄: ${forbidden}`);
}

const agents = fs.readFileSync(agentsPath, "utf8");
assert.match(agents, /繁體中文/, "AGENTS.md 必須保存語言偏好");
assert.match(agents, /src\/codexRunner\.js/, "AGENTS.md 必須記錄唯一 runtime 邊界");
assert.match(agents, /Logged in using ChatGPT/, "AGENTS.md 必須記錄 ChatGPT 登入安全契約");
assert.match(agents, /不得修改.*目標專案/s, "AGENTS.md 必須記錄目標專案邊界");
assert.match(agents, /git config --local user\.name/, "AGENTS.md 必須記錄驗收身分的唯一 Git 寫入例外");

const botEntrySource = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
assert.match(botEntrySource, /preflightCodexRuntime/, "index.js 啟動前必須驗證 Codex runtime");
const workerEntrySource = fs.readFileSync(path.join(root, "src", "worker.js"), "utf8");
const workerStartupSource = fs.readFileSync(path.join(root, "src", "workerStartup.js"), "utf8");
assert.match(workerEntrySource, /prepareWorkerRuntime/, "worker.js 啟動前必須執行安全準備");
assert.match(workerStartupSource, /preflightCodexRuntime/, "worker 啟動準備必須驗證 Codex runtime");
const indexSource = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
assert.match(indexSource, /makeBotMessageContent/, "bot 自產 Matrix 訊息必須加入可辨識標記");
assert.doesNotMatch(indexSource, /sendTextMessage/, "bot 自產訊息不得使用無標記的 sendTextMessage");

console.log("repositoryInstructions.test.js: repository instructions 通過 ✅");
