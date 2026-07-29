# Codex ChatGPT Runtime 安全閘門實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 element-bot 只使用該裝置已安裝、由 OpenAI 簽署且已用 ChatGPT 帳號登入的 Codex，拒絕 API Key、自訂 provider 與其他 agent，並以真實 Matrix 訊息驗證完整派發主流程。

**Architecture:** 純字串與設定判斷集中在新的 `src/codexRuntimePolicy.js`，不啟動任何程序；只有既有 `src/codexRunner.js` 負責解析、驗證及啟動 Codex。runner 快取執行檔身分，但每次模型呼叫前重新確認 ChatGPT 登入，bot 與 worker 啟動時也先執行唯讀 preflight。

**Tech Stack:** Node.js 22 CommonJS、Node `child_process`／`fs`／`path`、Windows Authenticode、Codex CLI、原生 `assert`、Matrix／檔案式 queue。

## Global Constraints

- 唯一允許的 agent runtime 是 OpenAI Codex CLI；不得 fallback 到 Cursor、Claude、Gemini、Aider 或其他 agent。
- 只有 `src/codexRunner.js` 可以解析或啟動 Codex；其他模組只能呼叫 runner 匯出的函式。
- 每次模型呼叫前必須以同一個絕對執行檔確認 `Logged in using ChatGPT`。
- API Key 登入、未登入、不明狀態、非 OpenAI 簽章、自訂 provider 或 base URL 都必須 fail closed。
- 不封鎖一般網路、不掃描目標專案設定、不影響目標專案 GitHub／GitLab 推送。
- 行為變更遵守 TDD；自動測試不得觸發正式規則指向的目標專案。
- Git commit message 使用繁體中文。

---

### Task 1: 純 Runtime 規則判斷

**Files:**
- Create: `src/codexRuntimePolicy.js`
- Create: `test/codexRuntimePolicy.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateCodexVersion(output)`、`validateChatGptLogin(stdout)`、`validateWindowsSignature(signature)`、`findUnsafeCodexConfig(text)`。
- All validators return normalized data on success and throw an error prefixed with `Codex runtime blocked:` on failure.

- [ ] **Step 1: 建立失敗測試**

```js
assert.strictEqual(validateCodexVersion("codex-cli 0.144.3"), "codex-cli 0.144.3");
assert.throws(() => validateCodexVersion("cursor 1.0"), /Codex runtime blocked:.*版本/);

assert.strictEqual(
  validateChatGptLogin("Logged in using ChatGPT\n"),
  "ChatGPT",
);
for (const output of [
  "Logged in using an API key",
  "Not logged in",
  "Logged in using ChatGPT\nLogged in using an API key",
]) {
  assert.throws(() => validateChatGptLogin(output), /Codex runtime blocked:.*登入/);
}

assert.doesNotThrow(() => validateWindowsSignature({
  status: "Valid",
  signer: 'CN="OpenAI OpCo, LLC"',
}));
assert.throws(
  () => validateWindowsSignature({ status: "Valid", signer: "Cursor Inc." }),
  /Codex runtime blocked:.*簽章/,
);

assert.strictEqual(findUnsafeCodexConfig('model = "gpt-5.6-sol"\n'), null);
for (const text of [
  'model_provider = "mistral"',
  'openai_base_url = "https://proxy.example.com"',
  'chatgpt_base_url = "https://proxy.example.com"',
  'profile = "paid"',
  '[profiles.paid]',
]) {
  assert.match(findUnsafeCodexConfig(text), /provider|base URL|profile/i);
}
```

- [ ] **Step 2: 執行測試並確認因模組不存在而失敗**

Run: `node test/codexRuntimePolicy.test.js`

Expected: FAIL with `Cannot find module '../src/codexRuntimePolicy'`.

- [ ] **Step 3: 實作最小純函式**

```js
function blocked(stage, detail) {
  const error = new Error(`Codex runtime blocked: ${stage}：${detail}`);
  error.code = "CODEX_RUNTIME_BLOCKED";
  error.stage = stage;
  return error;
}

function validateChatGptLogin(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.filter((line) => line === "Logged in using ChatGPT").length !== 1 ||
      lines.some((line) => /API key|Not logged in/i.test(line))) {
    throw blocked("登入", "必須使用此裝置已登入的 ChatGPT 帳號");
  }
  return "ChatGPT";
}
```

Implement the other three validators with exact conditions from the test and export all four functions plus `blocked`.

- [ ] **Step 4: 執行精準測試並加入完整測試序列**

Run: `node test/codexRuntimePolicy.test.js`

Expected: PASS with all policy cases reported.

Add `node test/codexRuntimePolicy.test.js` immediately before `node test/codexRunner.test.js` in `npm test`.

- [ ] **Step 5: 提交**

```bash
git add src/codexRuntimePolicy.js test/codexRuntimePolicy.test.js package.json
git commit -m "測試：定義 Codex ChatGPT runtime 規則"
```

### Task 2: Codex 執行檔、簽章、設定及登入 Preflight

**Files:**
- Modify: `src/codexRunner.js`
- Modify: `test/codexRunner.test.js`

**Interfaces:**
- Produces: `preflightCodexRuntime(options?) -> Promise<{ command, version, login: "ChatGPT" }>`。
- Extends: `runCodex(prompt, options)` accepts injected `runtimeOps` for tests and otherwise uses real filesystem/process operations.
- Reuses: Task 1 policy validators.

- [ ] **Step 1: 新增 runner 失敗測試**

```js
const runtimeOps = {
  platform: "win32",
  resolveCommand: async () => "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
  stat: async () => ({ size: 123, mtimeMs: 456, isFile: () => true }),
  verifySignature: async () => ({ status: "Valid", signer: 'CN="OpenAI OpCo, LLC"' }),
  readUserConfig: async () => 'model = "gpt-5.6-sol"\n',
  capture: async (command, args) => {
    if (args.includes("--version")) return { code: 0, stdout: "codex-cli 0.144.3", stderr: "" };
    if (args.includes("status")) return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    throw new Error("unexpected capture");
  },
};
const runtime = await preflightCodexRuntime({ command: "codex", runtimeOps });
assert.strictEqual(runtime.command, "C:\\Program Files\\OpenAI\\Codex\\codex.exe");

await assert.rejects(
  () => preflightCodexRuntime({
    command: "codex",
    runtimeOps: {
      ...runtimeOps,
      capture: async () => ({ code: 0, stdout: "Logged in using an API key", stderr: "" }),
    },
  }),
  /Codex runtime blocked:.*登入/,
);
```

Also assert that:

- `.cmd` and relative unresolved paths are rejected on Windows;
- invalid OpenAI signature is rejected before login;
- unsafe user config is rejected before login;
- unchanged file identity validates signature/version once but checks login on every preflight;
- changed size/mtime triggers signature/version validation again;
- `runCodex()` uses the resolved absolute path and includes `-c model_provider="openai"`;
- failed preflight never calls the `codex exec` spawn function.

- [ ] **Step 2: 執行 runner 測試並確認缺少 preflight 而失敗**

Run: `node test/codexRunner.test.js`

Expected: FAIL because `preflightCodexRuntime` is not exported.

- [ ] **Step 3: 實作解析、快取與檢查**

Implement inside `src/codexRunner.js`:

```js
async function preflightCodexRuntime(options = {}) {
  const ops = options.runtimeOps || defaultRuntimeOps;
  const requested = options.command || process.env.CODEX_COMMAND || "codex";
  const command = await ops.resolveCommand(requested);
  const identity = await readIdentity(command, ops);
  await validateIdentityIfChanged(command, identity, ops);
  validateUserConfig(await ops.readUserConfig());
  const login = await ops.capture(command, [
    "-c", 'model_provider="openai"',
    "login", "status",
  ]);
  if (login.code !== 0) throw blocked("登入", diagnostic(login.stderr, login.stdout));
  validateChatGptLogin(login.stdout);
  return { command, version: identityCache.version, login: "ChatGPT" };
}
```

Windows command resolution uses `where.exe`; explicit paths use `path.resolve`. Authenticode uses `powershell.exe -NoProfile -NonInteractive -Command` with the executable path passed as a separate argument and returns compact JSON containing only status and signer. User config is read from `path.join(os.homedir(), ".codex", "config.toml")`; missing file means empty config.

Change `runCodex()` so it awaits preflight first, then launches `runtime.command` with the existing args. Add `-c model_provider="openai"` to `buildCodexArgs()` before `exec`.

- [ ] **Step 4: 執行精準測試**

Run: `node test/codexRuntimePolicy.test.js`

Expected: PASS.

Run: `node test/codexRunner.test.js`

Expected: PASS, including existing timeout, output-schema and process-tree cases.

- [ ] **Step 5: 提交**

```bash
git add src/codexRunner.js test/codexRunner.test.js
git commit -m "功能：驗證裝置的 ChatGPT Codex runtime"
```

### Task 3: 啟動整合、操作文件與靜態邊界

**Files:**
- Modify: `src/index.js`
- Modify: `src/worker.js`
- Modify: `.env.example`
- Modify: `.agents/skills/setup-deploy-env/SKILL.md`
- Modify: `docs/codex-runtime-migration.md`
- Modify: `AGENTS.md`
- Modify: `test/repositoryInstructions.test.js`
- Modify: `test/runtimeMigration.test.js`

**Interfaces:**
- Consumes: `preflightCodexRuntime()` from Task 2.
- Startup behavior: bot and worker log the verified absolute Codex path and ChatGPT login, or fail startup with `Codex runtime blocked`.

- [ ] **Step 1: 新增文件與靜態邊界失敗斷言**

```js
assert.match(agents, /Logged in using ChatGPT/);
assert.match(setup, /codex login status/);
assert.match(setup, /OpenAI OpCo, LLC/);
assert.doesNotMatch(setup, /claude|cursor/i);

const indexSource = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "src", "worker.js"), "utf8");
for (const source of [indexSource, workerSource]) {
  assert.match(source, /preflightCodexRuntime/);
}
```

Extend runtime migration checks so strings and direct launch patterns for `cursor` are rejected alongside Claude, Gemini and Aider.

- [ ] **Step 2: 執行相關測試並確認缺少規則而失敗**

Run: `node test/repositoryInstructions.test.js`

Expected: FAIL because current instructions do not include the new login/signature contract.

- [ ] **Step 3: 整合啟動 preflight 並更新文件**

At the beginning of both `main()` functions, after loading config and before starting Matrix/queue work:

```js
const runtime = await preflightCodexRuntime();
console.log(`[codex] runtime 已驗證：${runtime.command}；登入=${runtime.login}`);
```

Update documents to state:

- `CODEX_COMMAND` may point to the Codex App bundled `.exe` but is never trusted without verification;
- Windows requires a valid OpenAI signature;
- setup uses `codex login status` and does not call a model merely to test authentication;
- only `Logged in using ChatGPT` passes;
- no other agent fallback is allowed;
- target-project network and Git behavior remain unchanged.

- [ ] **Step 4: 執行文件與靜態邊界測試**

Run: `node test/repositoryInstructions.test.js`

Expected: PASS.

Run: `node test/runtimeMigration.test.js`

Expected: PASS and report only `src/codexRunner.js` as the agent launch boundary.

- [ ] **Step 5: 提交**

```bash
git add src/index.js src/worker.js .env.example .agents/skills/setup-deploy-env/SKILL.md docs/codex-runtime-migration.md AGENTS.md test/repositoryInstructions.test.js test/runtimeMigration.test.js
git commit -m "文件：強制使用 ChatGPT 登入的 Codex"
```

### Task 4: 完整回歸與真實 Matrix 主流程驗證

**Files:**
- Temporary only: system-temp Git repository
- Temporary and restored in `finally`: `config/rules.json`
- Temporary and restored in `finally`: `storage/notify-config.json`
- Verify only: `queue/**`, `bot.log`, `worker.log`, Matrix room timeline

**Interfaces:**
- Consumes: running bot, worker, dashboard, Matrix credentials from existing `.env`, and the verified Codex runtime.
- Produces evidence for: room message captured → rule matched → pending queue → real Codex execution in temporary project → done result → notify outbox consumed → Matrix notification event.

- [ ] **Step 1: 執行完整本機測試**

Run: `npm test`

Expected: all suites PASS, including runtime policy, runner and static boundary tests.

Run: `git diff --check`

Expected: exit 0 with no output.

- [ ] **Step 2: 執行真實 Codex smoke**

Run: `npm run test:codex-smoke`

Expected: PASS using `Logged in using ChatGPT`; temporary repository is removed and formal rules are untouched.

- [ ] **Step 3: 安全重啟目前版本**

Follow `.agents/skills/restart-element-bot/SKILL.md`: verify no active judging/processing/publishing tasks, rotate logs, restart bot/worker/dashboard, and verify three PIDs plus `/api/status`.

Expected: startup logs contain the absolute verified Codex path and `登入=ChatGPT`.

- [ ] **Step 4: 建立隔離的真實測試資料**

Create a system-temp Git repository on branch `main`, configure test-only Git identity, commit `baseline.txt`, and leave it clean. Generate `marker` as `ELEMENT_BOT_E2E_20260729_${crypto.randomUUID()}`; select `roomId` from the first existing monitored room and assign the temporary repository path to `tempRepo`.

Back up the exact bytes of `config/rules.json` and `storage/notify-config.json`. Append one temporary rule:

```json
{
  "name": "element-bot-runtime-e2e",
  "keywords": ["${marker}"],
  "task": "skill-dispatch",
  "use_llm": false,
  "enabled": true,
  "rooms": ["${roomId}"],
  "project_path": "${tempRepo}",
  "target_branch": "main",
  "command": "建立 e2e-result.txt，內容只有 ${marker}，執行必要的本機驗證，不要 commit 或 push，最後以 success 回報。"
}
```

Temporarily enable notifications to the same monitored room. Wait until the rule watcher reports reload. A `finally` path must restore both original files byte-for-byte even when the test fails.

- [ ] **Step 5: 傳送 Matrix 訊息並輪詢完整流程**

Use existing `.env` Matrix account to log in a temporary device without printing password, token or recovery key. Send a plain unique test message containing only the marker to the selected monitored room.

Poll with conditions instead of fixed sleeps:

1. `output/messages.jsonl` contains the Matrix event id and marker.
2. A queue file with `source.event_id` appears.
3. The file moves through `pending`／`processing` and ends in `done`.
4. The temporary project contains `e2e-result.txt` with the exact marker.
5. The task log contains a Codex `{ status: "success" }` result.
6. The notify outbox file is consumed.
7. Matrix sync shows a later notification event from the bot in the configured room.

Allow at most the configured Codex timeout plus 120 seconds. On timeout, preserve relevant task id, queue state and log excerpts but redact all credentials.

- [ ] **Step 6: 還原並核對**

Restore rules and notify config byte-for-byte, remove the temporary project, and confirm no E2E rule remains. Confirm formal target repositories were not modified.

Run:

```bash
git status --short
git diff --check
node test/runtimeMigration.test.js
codex login status
```

Expected:

- only intended source/docs/test changes remain;
- existing ignored logs may remain untracked;
- runtime boundary passes;
- login still reports `Logged in using ChatGPT`.

- [ ] **Step 7: 處理真實流程發現的缺陷**

If the real flow exposes a reproducible product defect, stop the E2E run, preserve the exact task id and failure evidence, invoke the systematic-debugging workflow, add one failing regression test for that symptom, implement the smallest fix, then rerun Tasks 1–6 before reporting completion.
