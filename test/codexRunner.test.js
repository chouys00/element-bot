"use strict";
const assert = require("assert");
const fs = require("fs");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const {
  buildCodexArgs,
  deleteCodexSession,
  defaultTimeoutMs,
  preflightCodexRuntime,
  runCodex,
} = require("../src/codexRunner");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
async function rejects(name, fn, pattern) {
  let error;
  try { await fn(); } catch (e) { error = e; }
  ok(name, !!error && pattern.test(String(error.message || error)));
}

function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 12345;
  return child;
}

function fakeAppServerChild(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk;
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (line.trim()) handler(JSON.parse(line), child);
    }
  });
  child.stdin.on("finish", () => {
    child.stdout.end();
    child.stderr.end();
    process.nextTick(() => child.emit("close", 0));
  });
  return child;
}

function fakeRuntimeOps(name = "default") {
  const command = `C:\\Program Files\\OpenAI\\Codex\\${name}\\codex.exe`;
  const calls = {
    resolve: 0,
    stat: 0,
    signature: 0,
    config: 0,
    version: 0,
    login: 0,
  };
  let mtimeMs = 456;
  const ops = {
    platform: "win32",
    async resolveCommand(requested) {
      calls.resolve++;
      assert.strictEqual(requested, "codex");
      return command;
    },
    async stat(resolved) {
      calls.stat++;
      assert.strictEqual(resolved, command);
      return { size: 123, mtimeMs, isFile: () => true };
    },
    async verifySignature(resolved) {
      calls.signature++;
      assert.strictEqual(resolved, command);
      return {
        status: "Valid",
        signer: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"',
      };
    },
    async readUserConfig() {
      calls.config++;
      return 'model = "gpt-5.6-sol"\n';
    },
    async capture(resolved, args) {
      assert.strictEqual(resolved, command);
      if (args.includes("--version")) {
        calls.version++;
        return { code: 0, stdout: "codex-cli 0.144.3\n", stderr: "" };
      }
      if (args.includes("status")) {
        calls.login++;
        return {
          code: 0,
          stdout: "Logged in using ChatGPT\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected capture: ${args.join(" ")}`);
    },
  };
  return {
    command,
    calls,
    ops,
    changeIdentity() {
      mtimeMs++;
    },
  };
}

(async () => {
  const firstRuntime = fakeRuntimeOps("identity-cache");
  const firstPreflight = await preflightCodexRuntime({
    command: "codex",
    runtimeOps: firstRuntime.ops,
  });
  ok("preflight 回傳已驗證的絕對 Codex 路徑", firstPreflight.command === firstRuntime.command);
  ok("preflight 確認 ChatGPT 登入", firstPreflight.login === "ChatGPT");
  await preflightCodexRuntime({
    command: "codex",
    runtimeOps: firstRuntime.ops,
  });
  ok("執行檔未變時簽章只驗證一次", firstRuntime.calls.signature === 1);
  ok("執行檔未變時版本只驗證一次", firstRuntime.calls.version === 1);
  ok("每次 preflight 都重新檢查登入", firstRuntime.calls.login === 2);

  firstRuntime.changeIdentity();
  await preflightCodexRuntime({
    command: "codex",
    runtimeOps: firstRuntime.ops,
  });
  ok("執行檔資訊改變時重新驗證簽章", firstRuntime.calls.signature === 2);
  ok("執行檔資訊改變時重新驗證版本", firstRuntime.calls.version === 2);

  const stderrLoginRuntime = fakeRuntimeOps("stderr-login");
  stderrLoginRuntime.ops.capture = async (resolved, args) => {
    assert.strictEqual(resolved, stderrLoginRuntime.command);
    if (args.includes("--version")) {
      return { code: 0, stdout: "codex-cli 0.144.3\n", stderr: "" };
    }
    return {
      code: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
    };
  };
  const stderrLoginPreflight = await preflightCodexRuntime({
    command: "codex",
    runtimeOps: stderrLoginRuntime.ops,
  });
  ok(
    "接受 Codex 寫在 stderr 的 ChatGPT 登入狀態",
    stderrLoginPreflight.login === "ChatGPT",
  );

  const wrapperRuntime = fakeRuntimeOps("wrapper");
  wrapperRuntime.ops.resolveCommand = async () => "C:\\tools\\codex.cmd";
  await rejects(
    "Windows 拒絕 cmd wrapper",
    () => preflightCodexRuntime({ command: "codex", runtimeOps: wrapperRuntime.ops }),
    /Codex runtime blocked:.*解析/,
  );

  const unsignedRuntime = fakeRuntimeOps("unsigned");
  unsignedRuntime.ops.verifySignature = async () => ({
    status: "Valid",
    signer: "Cursor Inc.",
  });
  await rejects(
    "拒絕非 OpenAI 簽章",
    () => preflightCodexRuntime({ command: "codex", runtimeOps: unsignedRuntime.ops }),
    /Codex runtime blocked:.*簽章/,
  );

  const unsafeConfigRuntime = fakeRuntimeOps("unsafe-config");
  unsafeConfigRuntime.ops.readUserConfig = async () =>
    'model_provider = "mistral"\n';
  await rejects(
    "拒絕自訂 provider",
    () => preflightCodexRuntime({ command: "codex", runtimeOps: unsafeConfigRuntime.ops }),
    /Codex runtime blocked:.*設定/,
  );
  ok("設定不安全時不檢查登入", unsafeConfigRuntime.calls.login === 0);

  const apiKeyRuntime = fakeRuntimeOps("api-key");
  apiKeyRuntime.ops.capture = async (resolved, args) => {
    assert.strictEqual(resolved, apiKeyRuntime.command);
    if (args.includes("--version")) {
      return { code: 0, stdout: "codex-cli 0.144.3\n", stderr: "" };
    }
    return {
      code: 0,
      stdout: "Logged in using an API key\n",
      stderr: "",
    };
  };
  await rejects(
    "拒絕 API Key 登入",
    () => preflightCodexRuntime({ command: "codex", runtimeOps: apiKeyRuntime.ops }),
    /Codex runtime blocked:.*登入/,
  );

  const judgeArgs = buildCodexArgs("judge");
  ok("judge 使用 codex exec", judgeArgs.includes("exec"));
  ok("judge 使用 read-only", judgeArgs.includes("read-only"));
  ok("judge 使用 ephemeral", judgeArgs.includes("--ephemeral"));
  ok("judge 從 stdin 讀 prompt", judgeArgs[judgeArgs.length - 1] === "-");

  const probeArgs = buildCodexArgs("probe");
  ok("probe 使用 read-only", probeArgs.includes("read-only"));
  ok("judge 不覆寫使用者的模型設定", !judgeArgs.includes("--model"));
  ok("probe 不覆寫使用者的模型設定", !probeArgs.includes("--model"));
  ok("judge 不覆寫使用者的思考程度", !judgeArgs.includes('model_reasoning_effort="medium"'));
  ok("probe 不覆寫使用者的思考程度", !probeArgs.includes('model_reasoning_effort="medium"'));

  const executeArgs = buildCodexArgs("execute");
  ok("execute 使用 danger-full-access", executeArgs.includes("danger-full-access"));
  ok("execute 不使用 workspace-write", !executeArgs.includes("workspace-write"));
  ok("execute 不加入 workspace-write 專用網路設定", !executeArgs.includes("sandbox_workspace_write.network_access=true"));
  ok("execute 不略過 sandbox", !executeArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  ok("execute 固定使用 gpt-5.6-terra", executeArgs[executeArgs.indexOf("--model") + 1] === "gpt-5.6-terra");
  ok("execute 固定使用 medium 思考程度", executeArgs.includes('model_reasoning_effort="medium"'));

  const sessionId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const persistentExecuteArgs = buildCodexArgs("execute", { persistSession: true });
  ok("需要後續驗收的 execute 使用 JSONL", persistentExecuteArgs.includes("--json"));
  ok("需要後續驗收的 execute 保存 session", !persistentExecuteArgs.includes("--ephemeral"));
  ok("保存 session 的 execute 仍從 stdin 讀 prompt", persistentExecuteArgs[persistentExecuteArgs.length - 1] === "-");

  const resumeArgs = buildCodexArgs("execute", { resumeSessionId: sessionId });
  ok("驗收使用 exec resume", resumeArgs.includes("exec") && resumeArgs.includes("resume"));
  ok("驗收只續接指定 session", resumeArgs.includes(sessionId) && !resumeArgs.includes("--last"));
  ok("驗收對話仍會保存", !resumeArgs.includes("--ephemeral"));
  ok("驗收 prompt 仍從 stdin 傳入", resumeArgs[resumeArgs.length - 1] === "-");
  assert.throws(
    () => buildCodexArgs("execute", { resumeSessionId: "last" }),
    /session ID 不合法/,
    "resume 不接受別名或 --last",
  );
  passed++;
  ok(
    "所有模式固定使用內建 openai provider",
    executeArgs.includes('model_provider="openai"') &&
      judgeArgs.includes('model_provider="openai"') &&
      probeArgs.includes('model_provider="openai"'),
  );

  const oldAiTimeout = process.env.AI_TIMEOUT_MS;
  process.env.AI_TIMEOUT_MS = "1800000";
  ok("execute 預設沿用 AI_TIMEOUT_MS", defaultTimeoutMs("execute") === 1800000);
  ok("judge 預設不誤用長任務 timeout", defaultTimeoutMs("judge") === 120000);
  if (oldAiTimeout === undefined) delete process.env.AI_TIMEOUT_MS;
  else process.env.AI_TIMEOUT_MS = oldAiTimeout;

  assert.throws(() => buildCodexArgs("unknown"), /未知.*mode|mode.*unknown/i);
  passed++;

  let asyncCall;
  const runRuntime = fakeRuntimeOps("run-codex");
  const output = await runCodex("請回覆 ok", {
    mode: "probe",
    cwd: "D:/tmp/project",
    runtimeOps: runRuntime.ops,
    spawnFn(command, args, options) {
      asyncCall = { command, args, options };
      const child = fakeChild({ stdout: "ok\n", stderr: "progress\n" });
      let input = "";
      child.stdin.on("data", (chunk) => { input += chunk; });
      child.stdin.on("finish", () => { asyncCall.input = input; });
      return child;
    },
  });
  ok("非同步 runner 回傳 stdout", output === "ok\n");
  ok("非同步 runner 使用已驗證的絕對路徑", asyncCall.command === runRuntime.command);
  ok("非同步 runner 傳入 cwd", asyncCall.options.cwd === "D:/tmp/project");
  ok("Windows runner 不透過 shell，避免 timeout 留下 Codex 子程序", asyncCall.options.shell === false);
  ok("非同步 runner 以 stdin 傳 prompt", asyncCall.input === "請回覆 ok");

  const structuredOutput = '{"status":"success","output":"完成"}';
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: structuredOutput },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
    "",
  ].join("\n");
  const persistentResult = await runCodex("執行任務", {
    mode: "execute",
    persistSession: true,
    cwd: "D:/tmp/project",
    runtimeOps: runRuntime.ops,
    spawnFn: () => fakeChild({ stdout: jsonl }),
  });
  assert.deepStrictEqual(
    persistentResult,
    { output: structuredOutput, sessionId },
    "保存 session 時應從 JSONL 回傳精確 session ID 與最後 agent message",
  );
  passed++;

  const resumedResult = await runCodex("驗收", {
    mode: "execute",
    resumeSessionId: sessionId,
    cwd: "D:/tmp/project",
    runtimeOps: runRuntime.ops,
    spawnFn: () => fakeChild({ stdout: jsonl }),
  });
  assert.deepStrictEqual(
    resumedResult,
    { output: structuredOutput, sessionId },
    "resume 應維持同一個 session ID",
  );
  passed++;

  await rejects(
    "resume 拒絕 Codex 回報不同 session ID",
    () => runCodex("驗收", {
      mode: "execute",
      resumeSessionId: sessionId,
      cwd: "D:/tmp/project",
      runtimeOps: runRuntime.ops,
      spawnFn: () => fakeChild({ stdout: jsonl.replace(sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a54") }),
    }),
    /session ID 不一致/,
  );

  let deleteCall;
  const deleteMessages = [];
  const deleteResult = await deleteCodexSession(sessionId, {
    runtimeOps: runRuntime.ops,
    spawnFn(command, args, options) {
      deleteCall = { command, args, options };
      return fakeAppServerChild((message, child) => {
        deleteMessages.push(message);
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { codexHome: "C:/codex" } })}\n`);
        }
        if (message.method === "thread/delete") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      });
    },
  });
  assert.deepStrictEqual(
    deleteCall.args,
    ["app-server", "--stdio"],
    "session 清理由 runner 啟動官方 app-server",
  );
  passed++;
  assert.deepStrictEqual(
    deleteMessages.map((message) => message.method),
    ["initialize", "initialized", "thread/delete"],
    "完成 app-server 握手後只刪除精確 UUID",
  );
  passed++;
  ok("thread/delete 只收到精確 session ID", deleteMessages[2].params.threadId === sessionId);
  assert.deepStrictEqual(
    deleteResult,
    { deleted: true, metadataDeleted: true },
    "官方刪除完整成功時回報 metadata 也已刪除",
  );
  passed++;
  ok("delete 仍使用已驗證的 Codex 路徑", deleteCall.command === runRuntime.command);
  ok("delete 不透過 shell", deleteCall.options.shell === false);

  const missingRollout = `C:/codex/sessions/rollout-${sessionId}.jsonl`;
  const partialDelete = await deleteCodexSession(sessionId, {
    runtimeOps: runRuntime.ops,
    pathExists: async (value) => {
      assert.strictEqual(value, missingRollout);
      return false;
    },
    spawnFn() {
      return fakeAppServerChild((message, child) => {
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: { codexHome: "C:/codex" } })}\n`);
        }
        if (message.method === "thread/delete") {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            error: { code: -32603, message: "no such table: agent_jobs" },
          })}\n`);
        }
        if (message.method === "thread/read") {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            result: { thread: { id: sessionId, path: missingRollout } },
          })}\n`);
        }
      });
    },
  });
  ok("rollout 已消失時視為內容刪除成功", partialDelete.deleted === true);
  ok("Codex 索引未刪除時留下警告狀態", partialDelete.metadataDeleted === false && /agent_jobs/.test(partialDelete.warning));

  await rejects(
    "thread/delete 失敗且 rollout 仍存在時不得誤報成功",
    () => deleteCodexSession(sessionId, {
      runtimeOps: runRuntime.ops,
      pathExists: async () => true,
      spawnFn() {
        return fakeAppServerChild((message, child) => {
          if (message.method === "initialize") {
            child.stdout.write(`${JSON.stringify({ id: message.id, result: { codexHome: "C:/codex" } })}\n`);
          }
          if (message.method === "thread/delete") {
            child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32603, message: "busy" } })}\n`);
          }
          if (message.method === "thread/read") {
            child.stdout.write(`${JSON.stringify({
              id: message.id,
              result: { thread: { id: sessionId, path: `C:/codex/sessions/rollout-${sessionId}.jsonl` } },
            })}\n`);
          }
        });
      },
    }),
    /busy/,
  );
  await rejects(
    "delete 拒絕非 UUID session",
    () => deleteCodexSession("last", { runtimeOps: runRuntime.ops }),
    /session ID 不合法/,
  );

  let terminatedPid = null;
  await rejects(
    "timeout 會終止完整 Codex process tree",
    () => runCodex("x", {
      mode: "execute",
      timeoutMs: 5,
      runtimeOps: runRuntime.ops,
      spawnFn: () => hangingChild(),
      terminateFn: (child) => { terminatedPid = child.pid; },
    }),
    /timeout/i
  );
  ok("timeout 終止的是 Codex process tree 根 PID", terminatedPid === 12345);

  await rejects(
    "非零 exit 會同時提供 stderr 與 stdout 診斷",
    () => runCodex("x", {
      mode: "judge",
      runtimeOps: runRuntime.ops,
      spawnFn: () => fakeChild({ code: 7, stdout: "last output", stderr: "bad auth" }),
    }),
    /Codex CLI exit 7.*bad auth.*last output/s
  );

  let schemaPath;
  let schemaOnDisk;
  const schema = {
    type: "object",
    properties: { trigger: { type: "boolean" } },
    required: ["trigger"],
    additionalProperties: false,
  };
  await runCodex("判斷", {
    mode: "judge",
    outputSchema: schema,
    runtimeOps: runRuntime.ops,
    spawnFn(command, args) {
      schemaPath = args[args.indexOf("--output-schema") + 1];
      schemaOnDisk = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      return fakeChild({ stdout: '{"trigger":true}' });
    },
  });
  ok("output schema 在啟動 Codex 前寫入暫存檔", schemaOnDisk.required[0] === "trigger");
  ok("output schema 參數有傳給 Codex", typeof schemaPath === "string" && schemaPath.length > 0);
  ok("Codex 結束後清除 output schema 暫存檔", !fs.existsSync(schemaPath));

  let blockedExecStarted = false;
  await rejects(
    "preflight 失敗時不啟動 codex exec",
    () => runCodex("x", {
      mode: "judge",
      runtimeOps: apiKeyRuntime.ops,
      spawnFn: () => {
        blockedExecStarted = true;
        return fakeChild();
      },
    }),
    /Codex runtime blocked:.*登入/,
  );
  ok("preflight 失敗時 exec 完全沒有啟動", blockedExecStarted === false);

  ok("runner 不再暴露無法可靠終止 process tree 的同步介面", require("../src/codexRunner").runCodexSync === undefined);

  console.log(`codexRunner.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
