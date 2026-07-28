"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const skillPath = path.join(
  root,
  ".agents",
  "skills",
  "restart-element-bot",
  "SKILL.md"
);
const uiPath = path.join(
  root,
  ".agents",
  "skills",
  "restart-element-bot",
  "agents",
  "openai.yaml"
);

assert.ok(fs.existsSync(skillPath), "restart-element-bot/SKILL.md 必須存在");
assert.ok(
  fs.existsSync(uiPath),
  "restart-element-bot/agents/openai.yaml 必須存在"
);

const skill = fs.readFileSync(skillPath, "utf8");
const ui = fs.readFileSync(uiPath, "utf8");
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);

assert.ok(frontmatter, "SKILL.md 必須有 YAML frontmatter");
assert.match(frontmatter[1], /^name:\s*restart-element-bot$/m);
assert.match(frontmatter[1], /^description:\s*Use when /m);

for (const trigger of ["啟動", "啟動專案", "重啟", "重新啟動", "restart"]) {
  assert.ok(
    frontmatter[1].includes(trigger),
    `description 必須包含觸發詞：${trigger}`
  );
}

assert.match(
  skill,
  /「啟動」與「重啟」[^。\n]*相同語意/,
  "啟動與重啟必須是相同語意"
);
for (const active of ["judging", "processing", "publishing"]) {
  assert.ok(skill.includes(`\`${active}\``), `必須檢查活動狀態 ${active}`);
}
assert.match(skill, /操作當下確認/, "活動任務必須要求操作當下確認");

assert.match(skill, /repository 絕對路徑/, "PID 必須比對 repository 路徑");
for (const entry of [
  "src/index.js",
  "src/worker.js",
  "src/dashboard/index.js",
]) {
  assert.ok(skill.includes(`\`${entry}\``), `必須精確比對 ${entry}`);
}
assert.match(
  skill,
  /不得[^。\n]*終止所有 `node\.exe`/,
  "不得廣泛終止 Node 程序"
);
assert.ok(
  skill.includes("`taskkill /PID <pid> /T /F`"),
  "Windows 必須終止已驗證 PID 的完整 process tree"
);

assert.ok(skill.includes("`DASHBOARD_PORT`"), "必須讀取 .env 實際 port");
assert.match(
  skill,
  /不得[^。\n]*猜測[^。\n]*3000/,
  "不得猜測 dashboard 預設 port"
);
assert.match(
  skill,
  /不得[^。\n]*`npm run test:codex-smoke`/,
  "快速啟動不得執行 Codex smoke test"
);

assert.ok(
  skill.includes("`CreateProcessAsUserW failed: 5`"),
  "必須涵蓋本次 sandbox process creation 權限錯誤"
);
assert.match(
  skill,
  /立即改用[^。\n]*(host|主機)[^。\n]*提升權限/,
  "權限錯誤後必須直接切換到提升權限的主機 shell"
);
assert.match(
  skill,
  /不得[^。\n]*重試[^。\n]*sandbox/,
  "不得在已知失敗的 sandbox 重複試錯"
);

const rotateIndex = skill.indexOf("保留並輪替舊 log");
const botIndex = skill.indexOf("啟動 bot", rotateIndex);
const workerIndex = skill.indexOf("啟動 worker", botIndex);
const dashboardIndex = skill.indexOf("啟動 dashboard", workerIndex);
assert.ok(
  rotateIndex >= 0 &&
    rotateIndex < botIndex &&
    botIndex < workerIndex &&
    workerIndex < dashboardIndex,
  "遭拒後必須固定拆成：輪替 log → bot → worker → dashboard"
);
for (const detour of ["WMI", "排程工作", "computer-use"]) {
  assert.match(
    skill,
    new RegExp(`不得[^。\\n]*${detour}`),
    `不得把 ${detour} 當成啟動 fallback`
  );
}

assert.match(
  skill,
  /`Start-Process`[^。\n]*空輸出[^。\n]*不代表失敗/,
  "Start-Process 空輸出不得直接判失敗"
);
assert.match(
  skill,
  /`ArgumentList`[^。\n]*entry point[^。\n]*絕對路徑/,
  "新程序必須把絕對 entry point 寫進 command line，供下次精確驗證"
);
assert.match(
  skill,
  /不得使用 `-PassThru`/,
  "持續背景程序不得因 PassThru 被主機生命週期管理回收"
);
assert.match(
  skill,
  /`Start-Process`[^。\n]*`-WindowStyle Hidden`/,
  "Windows 背景服務必須使用獨立隱藏視窗，避免五分鐘後被主機回收"
);
assert.ok(
  skill.includes("`IndexOf`") &&
    skill.includes("`String.Contains(value, StringComparison)`"),
  "PowerShell 5.1 的 command line 比對必須避開不支援的 Contains overload"
);
assert.match(
  skill,
  /`Test-Path`[^。\n]*括住[^。\n]*`-and`/,
  "PowerShell 複合布林條件必須正確括住 cmdlet 呼叫"
);
assert.match(
  skill,
  /stderr[^。\n]*非零[^。\n]*不代表啟動失敗/,
  "Matrix E2EE 警告不得因 stderr 非零而誤判啟動失敗"
);
assert.match(skill, /條件式輪詢/);
assert.match(skill, /最多 120 秒/);
assert.match(skill, /HTTP 200/);
assert.match(skill, /`bot_online`[^。\n]*`true`/);
assert.match(skill, /heartbeat[^。\n]*90 秒/i);
assert.match(skill, /worker[^。\n]*PID/);

assert.match(ui, /display_name:\s*"重啟 element-bot"/);
assert.match(ui, /short_description:\s*".{25,64}"/u);
assert.match(
  ui,
  /default_prompt:\s*".*\$restart-element-bot.*"/,
  "預設提示必須明確引用 skill"
);

console.log("restartElementBotSkill.test.js: 啟動與重啟安全契約通過 ✅");
