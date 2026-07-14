# element-bot Codex 執行架構遷移實作計畫

> **給 agentic workers：** 必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans` 逐項執行此計畫。每個步驟使用 checkbox 追蹤。

**目標：** 將 element-bot 唯一的 LLM/agent 執行環境改為 Codex，並讓通用分派完全不依賴目標專案的 skill 目錄或工具體系。

**架構：** 新增 `src/codexRunner.js` 作為唯一 Codex CLI 邊界，judge、probe 與 executor 只呼叫它提供的同步或非同步介面。`skill-dispatch` 只傳遞目標專案路徑與 command，目標專案如何解讀 instructions/skills 完全交給 Codex 與該專案本身。

**技術棧：** Node.js 22、CommonJS、`child_process.spawn`/`spawnSync`、Codex CLI `exec`、既有自製 Node assert 測試。

## 全域限制

- 只修改 `D:/GB/element-bot`，不得修改任何目標專案。
- 只支援 Codex，不新增 `AI_PROVIDER` 或 Claude fallback。
- 任務對話、回覆、設計與計畫使用繁體中文；程式識別字與 CLI 指令維持原文。
- 只有 `src/codexRunner.js` 可以建構 Codex CLI 參數或啟動 `codex`。
- `skill-dispatch` 與 probe 不得包含 `.claude/skills`、`.agents/skills`、`.cursor/skills` 等目標 skill 路徑。
- judge/probe 使用 `read-only`；execute 使用開啟網路的 `workspace-write`；禁止 `danger-full-access`。
- 先寫失敗測試並確認正確失敗，再寫最小實作。
- 不重寫歷史 plans、specs、CHANGELOG 中忠實描述過去行為的內容。

---

### Task 1：集中式 Codex runner

**檔案：**

- 新增：`src/codexRunner.js`
- 新增：`test/codexRunner.test.js`
- 修改：`package.json`

**介面：**

- `buildCodexArgs(mode, options?) -> string[]`
- `runCodex(prompt, options?) -> Promise<string>`
- `runCodexSync(prompt, options?) -> string`
- options 支援 `mode`、`cwd`、`timeoutMs`、`outputSchema`、`spawnFn`/`spawnSyncFn` 測試注入。

- [ ] **Step 1：先新增失敗測試**

測試三種 mode 的參數、execute 網路設定、stdin/cwd、成功時只回傳 stdout、非零 exit 與 timeout 錯誤。核心斷言如下：

```js
const args = buildCodexArgs("execute");
assert.ok(args.includes("exec"));
assert.ok(args.includes("workspace-write"));
assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
assert.ok(!args.includes("danger-full-access"));
```

- [ ] **Step 2：執行測試並確認 RED**

執行：`node test/codexRunner.test.js`

預期：因 `../src/codexRunner` 尚不存在而失敗。

- [ ] **Step 3：實作最小 runner**

參數契約：

```js
const MODE_CONFIG = {
  judge: { sandbox: "read-only", network: false },
  probe: { sandbox: "read-only", network: false },
  execute: { sandbox: "workspace-write", network: true },
};
```

共同參數以 `--ask-for-approval never exec --ephemeral --sandbox <mode> --color never -` 組成；execute 額外加入 `-c sandbox_workspace_write.network_access=true`。`CODEX_COMMAND` 預設為 `codex`。

output schema 使用 `fs.mkdtempSync` 建立暫存 JSON，呼叫完成後在 `finally` 清除。錯誤只附最多 500 字的 stderr/stdout 診斷。

- [ ] **Step 4：確認 GREEN**

執行：`node test/codexRunner.test.js`

預期：全部通過。

- [ ] **Step 5：把測試加入 npm test 並提交**

```powershell
git add src/codexRunner.js test/codexRunner.test.js package.json
git commit -m "feat: centralize Codex CLI execution"
```

---

### Task 2：遷移 judge 與 probe

**檔案：**

- 修改：`src/judge.js`
- 修改：`src/probe.js`
- 修改：`test/judge.test.js`
- 修改：`test/probe.test.js`
- 修改：`test/judgeStatus.test.js`

**介面：**

- `judge()` 預設呼叫 `runCodex(prompt, { mode: "judge", outputSchema })`。
- `runProbe()` 預設呼叫 `runCodex(prompt, { mode: "probe", cwd })`，並維持 `{ok, output}` API。

- [ ] **Step 1：先修改測試以描述 Codex 行為**

新增 probe prompt 斷言：

```js
for (const forbidden of [".claude/skills", ".agents/skills", ".cursor/skills"]) {
  assert.ok(!seenPrompt.includes(forbidden));
}
assert.ok(seenPrompt.includes("目標專案自身"));
```

judge 測試需確認預設 runner 收到 `mode: "judge"` 與 `buildSchema(rule)`。

- [ ] **Step 2：執行並確認 RED**

執行：`node test/judge.test.js; node test/probe.test.js`

預期：仍輸出 Claude 路徑或沒有傳入 Codex mode/schema，因此失敗。

- [ ] **Step 3：移除兩檔內直接 spawn，改用 codexRunner**

Probe 提示詞固定包含：唯讀、不得修改、收到的 command、依目標專案自身 instructions/skills 說明預計流程；不得指定 skill 位置。

- [ ] **Step 4：執行相關測試確認 GREEN**

執行：`node test/judge.test.js; node test/probe.test.js; node test/judgeStatus.test.js`

- [ ] **Step 5：提交**

```powershell
git add src/judge.js src/probe.js test/judge.test.js test/probe.test.js test/judgeStatus.test.js
git commit -m "refactor: route judge and probe through Codex"
```

---

### Task 3：遷移 executor 並移除目標專案 skill 綁定

**檔案：**

- 修改：`src/executors/ops.js`
- 修改：`src/executors/defaultHandlers.js`
- 修改：`src/taskDefs.js`
- 修改：`test/taskDefs.test.js`
- 修改：`test/defaultHandlers.test.js`
- 修改：`test/executorIntegration.test.js`

**介面：**

- ops 匯出 `runCodex`，內部呼叫 `runCodexSync(prompt, {mode:"execute", cwd:projectDir})`。
- handlers 只依賴 `ops.runCodex`。
- task names 只保留 `demo-skill`、`skill-dispatch`。

- [ ] **Step 1：先寫失敗測試**

測試需確認：

```js
assert.ok(!taskNames().includes("i18n-skill"));
assert.throws(() => getTaskDef("i18n-skill"));
const prompt = getTaskDef("skill-dispatch").prompt({ command: "/do work" });
assert.ok(prompt.includes("/do work"));
for (const path of [".claude/skills", ".agents/skills", ".cursor/skills"]) assert.ok(!prompt.includes(path));
```

Handlers/integration fake ops 全部改用 `runCodex`，確保舊 `runClaude` 不再被呼叫。

- [ ] **Step 2：執行並確認 RED**

執行：`node test/taskDefs.test.js; node test/defaultHandlers.test.js; node test/executorIntegration.test.js`

預期：`i18n-skill` 仍存在且 handlers 仍呼叫 `runClaude`。

- [ ] **Step 3：完成最小遷移**

刪除 `FTL_ROOT`、`I18N_SKILL_DIR`、`i18n-skill` 與 `NSL_SKILL_DIR`/`NSL_PY` 使用。`skill-dispatch` 提示詞只要求 Codex依目標專案自身設定處理 command，保留既有不主動 commit/push/tag/reset 的限制。

- [ ] **Step 4：確認 GREEN**

執行：`node test/taskDefs.test.js; node test/defaultHandlers.test.js; node test/executorIntegration.test.js`

- [ ] **Step 5：提交**

```powershell
git add src/executors/ops.js src/executors/defaultHandlers.js src/taskDefs.js test/taskDefs.test.js test/defaultHandlers.test.js test/executorIntegration.test.js
git commit -m "refactor: make task dispatch target-system neutral"
```

---

### Task 4：現行 UI、log 與文件命名遷移

**檔案：**

- 修改：`src/index.js`
- 修改：`src/dashboard/server.js`
- 修改：`src/dashboard/aggregate.js`
- 修改：`src/dashboard/public/index.html`
- 修改：`src/dashboard/public/rules.html`
- 修改：`test/dashboardServer.test.js`
- 修改：`test/progress.test.js`
- 修改：`.env.example`
- 修改：`.gitignore`

- [ ] **Step 1：先把測試期望改為 Codex/agent-neutral 顯示**

將 `claude` 測試 fixture、錯誤文字與 `ai_output` 說明改為 Codex，但保留資料欄位 `ai_output`，避免 queue/log 格式不必要變更。

- [ ] **Step 2：執行並確認 RED**

執行：`node test/dashboardServer.test.js; node test/progress.test.js`

- [ ] **Step 3：更新所有現行 source/UI 文案**

使用「Codex」或「agent 執行輸出」，不變更歷史文件。`.env.example` 新增 `CODEX_COMMAND` 並移除 Claude quota 說明；`.gitignore` 改為完整忽略 `.claude/`。

- [ ] **Step 4：確認 GREEN 並提交**

```powershell
node test/dashboardServer.test.js
node test/progress.test.js
git add src/index.js src/dashboard .env.example .gitignore test/dashboardServer.test.js test/progress.test.js
git commit -m "chore: update active runtime copy for Codex"
```

---

### Task 5：Repository skills、AGENTS 與遷移文件

**檔案：**

- 新增：`AGENTS.md`
- 新增/修改：`.agents/skills/setup-deploy-env/SKILL.md`
- 新增：`.agents/skills/switch-matrix-account/SKILL.md`
- 刪除：`.claude/skills/setup-deploy-env/SKILL.md`
- 刪除：`.claude/skills/switch-matrix-account/SKILL.md`
- 新增：`docs/codex-runtime-migration.md`

- [ ] **Step 1：修正 setup skill**

使用 `codex --ask-for-approval never exec --ephemeral --sandbox read-only "回覆 ok 兩字即可"` 驗證登入。不檢查目標 skill 目錄，只檢查規則的 `project_path` 存在、為 Git repository、工作區乾淨。

- [ ] **Step 2：新增根目錄 AGENTS.md**

記錄 runtime 單一邊界、繁體中文偏好、禁止修改目標專案、TDD 與驗證命令。

- [ ] **Step 3：撰寫精準還原文件**

`docs/codex-runtime-migration.md` 列出每個 live file、Codex/Claude 旗標對照、Git commit 邊界，以及「只替換 runner 與呼叫介面，禁止全 repository 搜尋取代歷史內容」。

- [ ] **Step 4：檢查 skill frontmatter 與現行引用**

執行：

```powershell
rg -n -i '(claude|\.claude/skills|\.cursor/skills)' AGENTS.md .agents src test .env.example README.md
```

預期：只允許遷移文件中明確描述未來還原的 Claude 文字；runtime 與 setup skill 不得命中。

- [ ] **Step 5：提交**

```powershell
git add AGENTS.md .agents .claude .gitignore docs/codex-runtime-migration.md
git commit -m "docs: complete repository migration to Codex"
```

---

### Task 6：真實 smoke test 與完整驗證

**檔案：**

- 新增：`test/codexSmoke.test.js`
- 修改：`package.json`

- [ ] **Step 1：新增 opt-in smoke test**

腳本建立 `%TEMP%` 下的臨時 Git repository。第一輪用 `read-only` 要求只回覆固定字串；第二輪用 `execute` 建立 `codex-smoke.txt`，確認內容後在 `finally` 刪除臨時目錄。不得載入 `.env` 或任何規則目標路徑。

- [ ] **Step 2：執行真實 Codex smoke test**

執行：`npm run test:codex-smoke`

預期：read-only 回覆成功，workspace-write 建立指定檔案，exit code 0。

- [ ] **Step 3：執行完整測試**

執行：`npm test`

預期：全部測試通過。

- [ ] **Step 4：執行靜態遷移檢查**

```powershell
rg -n 'spawn(Sync)?\("claude"|runClaude|\.claude/skills|\.cursor/skills' src test .agents .env.example
git diff --check
git status --short
```

預期：第一個搜尋無命中；diff check 無錯誤；status 只包含預期變更。

- [ ] **Step 5：提交 smoke test 或必要修正**

```powershell
git add test/codexSmoke.test.js package.json
git commit -m "test: verify real Codex headless execution"
```

---

### Task 7：啟動驗收環境

**檔案：** 無程式碼變更。

- [ ] **Step 1：確認沒有舊 element-bot 程序佔用資源**

只辨識 command line 包含本 repository `src/index.js`、`src/worker.js`、`src/dashboard/index.js` 的 Node 程序，不終止無關 Node 程序。

- [ ] **Step 2：背景啟動三個程序**

使用隱藏視窗與既有 log 檔啟動 bot、worker、dashboard。

- [ ] **Step 3：確認健康狀態**

檢查程序仍存活、錯誤 log 無啟動失敗，並呼叫 `http://127.0.0.1:3000/api/status`。若 `.env` 使用不同 port，依實際設定呼叫。

- [ ] **Step 4：交付驗收資訊**

回報 branch、commit、測試結果、三個 PID、dashboard URL，以及使用者應在聊天室執行的最終分派驗收步驟。不得由自動測試觸發正式目標專案修改。
