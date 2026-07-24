# element-bot 快速啟動／重啟技能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 project skill，讓使用者說「啟動」或「重啟」時安全重載 element-bot 目前程式碼，不再誤跑完整 Codex smoke test。

**Architecture:** 新增自包含的 `restart-element-bot` skill，以 frontmatter 負責自然語言路由，以低自由度的操作契約規定活動任務閘門、精確 PID、重啟與驗證。新增 Node 契約測試鎖住觸發詞與安全規則，並接入現有 `npm test`；不修改 runtime source，也不新增可直接終止程序的腳本。

**Tech Stack:** Codex project skills（Markdown/YAML）、Node.js 22、內建 `assert`、PowerShell/Windows 程序管理指令

## Global Constraints

- 任務對話、文件與 Git commit message 使用繁體中文。
- `啟動`、`啟動專案`、`重啟`、`重新啟動`、`restart` 都代表安全重載目前磁碟版本。
- `judging`、`processing`、`publishing` 任一大於零時，不得在取得當下確認前終止程序。
- 只能終止同時匹配 repository 絕對路徑與 entry point 的 bot、worker、dashboard；不得廣泛終止 `node.exe`。
- 快速流程不得執行 `npm run test:codex-smoke`、安裝依賴或修改 Matrix／規則設定。
- `.env` 只讀取 dashboard host/port 與欄位是否存在；不得輸出 Matrix 密碼或 recovery key。
- 保留使用者現有的 `package-lock.json` 修改，不得 stage、還原或提交。
- 不得讓自動測試啟動正式服務、終止程序或修改規則指向的目標專案。

## RED 基準證據

在 `restart-element-bot` 尚不存在時，實際對話已重現失敗：使用者只說「把專案啟動起來」，agent 卻選用新機器部署用的 `setup-deploy-env`、執行耗時的真實 Codex smoke，並因假設預設 port 3000 而誤判實際 port 53000 的 dashboard 狀態。新 skill 必須直接修正這三個基準失敗：錯誤路由、非必要 smoke、忽略 `.env` 實際 port。

---

### Task 1: 建立會失敗的 skill 契約測試

**Files:**
- Create: `test/restartElementBotSkill.test.js`
- Modify: `package.json`
- Test: `test/restartElementBotSkill.test.js`

**Interfaces:**
- Consumes: repository 根目錄、`.agents/skills/restart-element-bot/SKILL.md`、`.agents/skills/restart-element-bot/agents/openai.yaml`
- Produces: 可由 `node test/restartElementBotSkill.test.js` 執行的 skill 結構與安全規則契約

- [ ] **Step 1: 新增契約測試，但不要建立 skill**

建立 `test/restartElementBotSkill.test.js`：

```js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const skillPath = path.join(root, ".agents", "skills", "restart-element-bot", "SKILL.md");
const uiPath = path.join(root, ".agents", "skills", "restart-element-bot", "agents", "openai.yaml");

assert.ok(fs.existsSync(skillPath), "restart-element-bot/SKILL.md 必須存在");
assert.ok(fs.existsSync(uiPath), "restart-element-bot/agents/openai.yaml 必須存在");

const skill = fs.readFileSync(skillPath, "utf8");
const ui = fs.readFileSync(uiPath, "utf8");
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter, "SKILL.md 必須有 YAML frontmatter");
assert.match(frontmatter[1], /^name:\s*restart-element-bot$/m);
assert.match(frontmatter[1], /^description:\s*Use when /m);

for (const trigger of ["啟動", "啟動專案", "重啟", "重新啟動", "restart"]) {
  assert.ok(frontmatter[1].includes(trigger), `description 必須包含觸發詞 ${trigger}`);
}

assert.match(skill, /啟動.*重啟.*相同|重啟.*啟動.*相同/s, "啟動與重啟必須是相同行為");
for (const active of ["judging", "processing", "publishing"]) {
  assert.ok(skill.includes(`\`${active}\``), `必須檢查活動狀態 ${active}`);
}
assert.match(skill, /當下確認|再次確認/, "活動任務必須要求 action-time confirmation");
assert.match(skill, /repository 絕對路徑/, "PID 必須匹配 repository 路徑");
for (const entry of ["src/index.js", "src/worker.js", "src/dashboard/index.js"]) {
  assert.ok(skill.includes(`\`${entry}\``), `必須精確匹配 ${entry}`);
}
assert.match(skill, /不得.*所有 `node\.exe`|不得.*全部 `node\.exe`/s, "不得廣泛終止 Node 程序");
assert.ok(skill.includes("`taskkill /PID <pid> /T /F`"), "Windows 必須終止完整 process tree");
assert.match(skill, /DASHBOARD_PORT/, "必須使用 .env 的實際 dashboard port");
assert.match(skill, /不得執行 `npm run test:codex-smoke`/, "快速流程必須禁止真實 smoke test");
assert.match(skill, /HTTP 200/);
assert.match(skill, /`bot_online`.*`true`/s);
assert.match(skill, /heartbeat.*90 秒/s);
assert.match(skill, /worker.*存活/s);

assert.match(ui, /display_name:\s*"重啟 element-bot"/);
assert.match(ui, /short_description:\s*".{25,64}"/u);
assert.match(ui, /default_prompt:\s*".*\$restart-element-bot.*"/);

console.log("restartElementBotSkill.test.js: skill 觸發、安全閘門與驗證契約通過 ✅");
```

- [ ] **Step 2: 把契約測試接入完整測試**

在 `package.json` 的 `scripts.test` 最後附加：

```text
 && node test/restartElementBotSkill.test.js
```

- [ ] **Step 3: 執行 RED，確認因 skill 尚不存在而失敗**

Run:

```powershell
node test/restartElementBotSkill.test.js
```

Expected: exit code 非 0，錯誤包含：

```text
restart-element-bot/SKILL.md 必須存在
```

不得先建立 skill，也不得把測試改成在檔案不存在時跳過。

---

### Task 2: 初始化並撰寫最小可用 skill

**Files:**
- Create: `.agents/skills/restart-element-bot/SKILL.md`
- Create: `.agents/skills/restart-element-bot/agents/openai.yaml`
- Test: `test/restartElementBotSkill.test.js`

**Interfaces:**
- Consumes: Task 1 的檔案與文字契約、既有 `setup-deploy-env`
- Produces: 可由 Codex 隱式觸發的 `restart-element-bot` project skill

- [ ] **Step 1: 使用官方 initializer 建立 skill 骨架**

Run:

```powershell
python "C:\Users\patrick.zyx\.codex\skills\.system\skill-creator\scripts\init_skill.py" restart-element-bot --path ".agents\skills" --interface 'display_name=重啟 element-bot' --interface 'short_description=安全重載 bot、worker 與 dashboard 的目前版本' --interface 'default_prompt=使用 $restart-element-bot 安全重啟目前版本的 element-bot。'
```

Expected:

```text
.agents/skills/restart-element-bot/SKILL.md
.agents/skills/restart-element-bot/agents/openai.yaml
```

- [ ] **Step 2: 以完整內容取代生成的 SKILL.md**

`.agents/skills/restart-element-bot/SKILL.md` 的最終內容：

```markdown
---
name: restart-element-bot
description: Use when working in element-bot and the user says「啟動」、「啟動專案」、「重啟」、「重新啟動」或「restart」，或要求讓目前磁碟上的程式碼重新運行；不適用於新機器建置、部署、setup 或完整驗證。
---

# 重啟 element-bot

## 核心語意

把「啟動」與「重啟」視為相同行為：安全停止本 repository 的 bot、worker、dashboard，再以目前磁碟內容全部啟動。不要因服務已在線就直接回報完成。

「檢查狀態」是唯讀操作；不要重啟。「建置環境」、「部署」、「setup」或「完整驗證」改用 `setup-deploy-env`。

## 操作契約

1. 取得 repository 絕對路徑。從 `.env` 讀取 `DASHBOARD_HOST`、`DASHBOARD_PORT`；只回報欄位是否存在與實際 dashboard 位址，不輸出 Matrix 機密。
2. 呼叫 `http://127.0.0.1:<port>/api/status`。API 不可用時，改讀 `queue/judging`、`queue/processing`、`queue/publishing`。
3. 若 `judging`、`processing`、`publishing` 任一大於零，列出數量與可取得的任務 ID，停止操作並要求使用者當下確認。即使原指令是「強制重啟」，也要在發現活動任務後再次確認。
4. 使用主機程序資訊識別三個 entry point：
   - bot：`src/index.js`
   - worker：`src/worker.js`
   - dashboard：`src/dashboard/index.js`
5. PID 必須同時匹配 repository 絕對路徑與 entry point。`storage/bot.lock` 與 dashboard owning PID 只能輔助定位。若無法唯一確認，停止並回報；不得終止所有 `node.exe` 或猜測 PID。
6. 保存既有六個標準日誌，以時間戳重新命名。對每個已確認 PID 執行 `taskkill /PID <pid> /T /F`，等待舊程序全部退出；原本沒有程序時直接進入啟動。
7. Windows 以隱藏背景程序啟動 `node src/index.js`、`node src/worker.js`、`node src/dashboard/index.js`，stdout/stderr 寫回各自的 `*.log` 與 `*-err.log`。
8. 不得執行 `npm run test:codex-smoke`、`npm install` 或完整測試；缺少 Node、依賴、`.env` 時停止並引導使用 `setup-deploy-env`。

## 驗證

以條件輪詢最長 120 秒，不使用固定長時間等待。只有下列條件全數成立才回報成功：

- dashboard 首頁與 `/api/status` 回 HTTP 200。
- `bot_online` 是 `true`，heartbeat 不超過 90 秒。
- worker 程序存活，`worker-err.log` 沒有啟動失敗。
- dashboard 使用 `.env` 的 host/port；可取得區網 IPv4 時，區網網址也回 HTTP 200。

回報啟動耗時、本機／區網網址、新 PID 與監聽房間數。若任一程序提前退出，回報該程序與錯誤日誌尾端，不宣稱整體成功。歷史 E2EE 解密警告不等於新訊息同步失敗。
```

- [ ] **Step 3: 確認 UI metadata 是最小且一致**

`.agents/skills/restart-element-bot/agents/openai.yaml` 的最終內容：

```yaml
interface:
  display_name: "重啟 element-bot"
  short_description: "安全重載 bot、worker 與 dashboard 的目前版本"
  default_prompt: "使用 $restart-element-bot 安全重啟目前版本的 element-bot。"
```

- [ ] **Step 4: 執行 skill validator**

Run:

```powershell
python "C:\Users\patrick.zyx\.codex\skills\.system\skill-creator\scripts\quick_validate.py" ".agents\skills\restart-element-bot"
```

Expected: exit code 0，輸出：

```text
Skill is valid!
```

- [ ] **Step 5: 執行 GREEN，確認契約測試通過**

Run:

```powershell
node test/restartElementBotSkill.test.js
```

Expected:

```text
restartElementBotSkill.test.js: skill 觸發、安全閘門與驗證契約通過 ✅
```

- [ ] **Step 6: 檢查 skill 大小與 placeholder**

Run:

```powershell
$skill = ".agents\skills\restart-element-bot\SKILL.md"
(Get-Content -Encoding UTF8 -LiteralPath $skill).Count
rg -n "TODO|TBD|PLACEHOLDER|待定|暫定" $skill
```

Expected: 少於 500 行；`rg` exit code 1，沒有 placeholder。

- [ ] **Step 7: 建立 GREEN commit**

Run:

```powershell
git add -- ".agents/skills/restart-element-bot/SKILL.md" ".agents/skills/restart-element-bot/agents/openai.yaml" "test/restartElementBotSkill.test.js" "package.json"
git commit -m "新增：快速啟動與重啟技能"
```

提交前以 `git diff --cached --name-only` 確認沒有 `package-lock.json`。

---

### Task 3: 完整驗證與路由邊界檢查

**Files:**
- Verify: `.agents/skills/restart-element-bot/SKILL.md`
- Verify: `.agents/skills/setup-deploy-env/SKILL.md`
- Verify: `test/restartElementBotSkill.test.js`
- Verify: `package.json`

**Interfaces:**
- Consumes: Task 2 的已提交 skill 與測試
- Produces: 完整測試、skill validation、路由邊界與 repository guard 的驗證證據

- [ ] **Step 1: 驗證兩個 skill 的 description 不互相覆蓋**

Run:

```powershell
rg -n "^description:" ".agents\skills\restart-element-bot\SKILL.md" ".agents\skills\setup-deploy-env\SKILL.md"
```

Expected:

```text
restart-element-bot ... 啟動 ... 重啟 ... restart
setup-deploy-env ... 新機器 ... 建置環境 ... 部署到這台 ... setup
```

- [ ] **Step 2: 執行完整測試**

Run:

```powershell
npm test
```

Expected: exit code 0，既有測試與：

```text
restartElementBotSkill.test.js: skill 觸發、安全閘門與驗證契約通過 ✅
```

全部通過。自動測試不得啟動、停止或重啟正式服務。

- [ ] **Step 3: 執行 repository 完成前守門**

Run:

```powershell
git diff --check
node test/runtimeMigration.test.js
node test/repositoryInstructions.test.js
```

Expected:

```text
runtimeMigration.test.js: 48 個現行檔案通過 ✅
repositoryInstructions.test.js: repository instructions 通過 ✅
```

- [ ] **Step 4: 驗證工作樹只保留使用者既有修改**

Run:

```powershell
git status --short
```

Expected:

```text
 M package-lock.json
```

若出現其他實作檔案，表示 Task 2 commit 不完整；補提交實作檔案，但不得 stage `package-lock.json`。
