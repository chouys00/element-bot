"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  blocked,
  validateCodexVersion,
  validateChatGptLogin,
  validateWindowsSignature,
  findUnsafeCodexConfig,
} = require("./codexRuntimePolicy");

const MODE_CONFIG = Object.freeze({
  judge: { sandbox: "read-only", network: false },
  probe: { sandbox: "read-only", network: false },
  execute: {
    sandbox: "danger-full-access",
    network: true,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  },
});

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireSessionId(value) {
  const sessionId = String(value || "");
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Codex session ID 不合法");
  return sessionId;
}

function defaultTimeoutMs(mode) {
  if (mode !== "execute") return 120000;
  const configured = parseInt(process.env.AI_TIMEOUT_MS || "1800000", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 1800000;
}

function buildCodexArgs(mode, options = {}) {
  const config = MODE_CONFIG[mode];
  if (!config) throw new Error(`未知的 Codex mode: ${mode}`);

  const args = [
    "--ask-for-approval",
    "never",
    "-c",
    'model_provider="openai"',
  ];
  if (config.model) args.push("--model", config.model);
  if (config.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${config.reasoningEffort}"`);
  }
  if (config.network && config.sandbox === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  if (options.resumeSessionId) {
    const sessionId = requireSessionId(options.resumeSessionId);
    args.push(
      "--sandbox", config.sandbox,
      "exec",
      "resume",
      "--json",
    );
    if (options.outputSchemaPath) {
      args.push("--output-schema", options.outputSchemaPath);
    }
    args.push(sessionId, "-");
    return args;
  }

  args.push("exec");
  if (options.persistSession) args.push("--json");
  else args.push("--ephemeral");
  args.push("--sandbox", config.sandbox, "--color", "never");
  if (options.outputSchemaPath) {
    args.push("--output-schema", options.outputSchemaPath);
  }
  args.push("-");
  return args;
}

function diagnostic(stderr, stdout) {
  return [String(stderr || "").trim(), String(stdout || "").trim()]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500) || "無診斷輸出";
}

function parseCodexJsonl(stdout, expectedSessionId) {
  const events = String(stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Codex JSONL 第 ${index + 1} 行不合法: ${error.message}`);
      }
    });
  const started = events.find((event) => event && event.type === "thread.started");
  const sessionId = started && started.thread_id;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("Codex JSONL 缺少 thread.started session ID");
  }
  if (expectedSessionId && sessionId !== expectedSessionId) {
    throw new Error(`Codex resume session ID 不一致: 預期 ${expectedSessionId}，實際 ${sessionId}`);
  }
  const messages = events.filter((event) =>
    event && event.type === "item.completed" && event.item &&
    event.item.type === "agent_message" && typeof event.item.text === "string");
  if (!messages.length) throw new Error("Codex JSONL 缺少最終 agent message");
  return {
    output: messages[messages.length - 1].item.text,
    sessionId,
  };
}

function asBlocked(stage, error) {
  if (error && error.code === "CODEX_RUNTIME_BLOCKED") return error;
  return blocked(stage, String((error && error.message) || error || "未知錯誤"));
}

function captureProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(reject, new Error(`timeout(${timeoutMs}ms)`));
    }, timeoutMs);
    child.on("error", (error) => finish(reject, error));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      finish(resolve, { code, stdout, stderr });
    });
  });
}

async function resolveCommand(requested) {
  const value = String(requested || "").trim();
  if (!value) throw blocked("解析", "CODEX_COMMAND 不得為空");
  if (path.isAbsolute(value)) return path.normalize(value);
  if (/[\\/]/.test(value)) return path.resolve(value);

  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = await captureProcess(lookup, [value]);
  if (result.code !== 0) {
    throw blocked("解析", diagnostic(result.stderr, result.stdout));
  }
  const resolved = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!resolved || !path.isAbsolute(resolved)) {
    throw blocked("解析", `找不到 ${value} 的絕對執行檔路徑`);
  }
  return path.normalize(resolved);
}

async function verifyWindowsSignature(command) {
  const escaped = String(command).replace(/'/g, "''");
  const script = [
    `$signature=Get-AuthenticodeSignature -LiteralPath '${escaped}';`,
    "$signer=if($signature.SignerCertificate){$signature.SignerCertificate.Subject}else{''};",
    "[PSCustomObject]@{status=[string]$signature.Status;signer=[string]$signer}",
    "| ConvertTo-Json -Compress",
  ].join("");
  const result = await captureProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 30000 },
  );
  if (result.code !== 0) {
    throw blocked("簽章", diagnostic(result.stderr, result.stdout));
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    throw blocked("簽章", `無法解析 Authenticode 結果：${error.message}`);
  }
}

async function readUserConfig() {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  try {
    return await fs.promises.readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

const defaultRuntimeOps = {
  platform: process.platform,
  resolveCommand,
  stat: (filePath) => fs.promises.stat(filePath),
  verifySignature: verifyWindowsSignature,
  readUserConfig,
  capture: (command, args) => captureProcess(command, args),
};

const identityCache = new Map();

async function preflightCodexRuntime(options = {}) {
  const ops = options.runtimeOps || defaultRuntimeOps;
  const platform = ops.platform || process.platform;
  const runtimePath = platform === "win32" ? path.win32 : path;
  const requested = options.command || process.env.CODEX_COMMAND || "codex";
  let command;
  try {
    command = await ops.resolveCommand(requested);
  } catch (error) {
    throw asBlocked("解析", error);
  }
  if (!runtimePath.isAbsolute(command)) {
    throw blocked("解析", "Codex 執行檔必須解析成絕對路徑");
  }
  if (platform === "win32" && runtimePath.extname(command).toLowerCase() !== ".exe") {
    throw blocked("解析", "Windows 只能使用原生 codex.exe");
  }

  let stat;
  try {
    stat = await ops.stat(command);
  } catch (error) {
    throw asBlocked("解析", error);
  }
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) {
    throw blocked("解析", "Codex 執行檔路徑不是一般檔案");
  }

  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  let identity = identityCache.get(command);
  if (!identity || identity.fingerprint !== fingerprint) {
    if (platform === "win32") {
      let signature;
      try {
        signature = await ops.verifySignature(command);
      } catch (error) {
        throw asBlocked("簽章", error);
      }
      validateWindowsSignature(signature);
    }
    let versionResult;
    try {
      versionResult = await ops.capture(command, ["--version"]);
    } catch (error) {
      throw asBlocked("版本", error);
    }
    if (!versionResult || versionResult.code !== 0) {
      throw blocked(
        "版本",
        diagnostic(versionResult && versionResult.stderr, versionResult && versionResult.stdout),
      );
    }
    identity = {
      fingerprint,
      version: validateCodexVersion(versionResult.stdout),
    };
    identityCache.set(command, identity);
  }

  let userConfig;
  try {
    userConfig = await ops.readUserConfig();
  } catch (error) {
    throw asBlocked("設定", error);
  }
  const unsafeConfig = findUnsafeCodexConfig(userConfig);
  if (unsafeConfig) {
    throw blocked("設定", `使用者 Codex 設定含有${unsafeConfig}`);
  }

  let loginResult;
  try {
    loginResult = await ops.capture(command, [
      "-c",
      'model_provider="openai"',
      "login",
      "status",
    ]);
  } catch (error) {
    throw asBlocked("登入", error);
  }
  if (!loginResult || loginResult.code !== 0) {
    throw blocked(
      "登入",
      diagnostic(loginResult && loginResult.stderr, loginResult && loginResult.stdout),
    );
  }
  const login = validateChatGptLogin(
    [loginResult.stdout, loginResult.stderr].filter(Boolean).join("\n"),
  );
  return { command, version: identity.version, login };
}

function prepareInvocation(mode, options) {
  if (!options.outputSchema) {
    return { args: buildCodexArgs(mode, options), cleanup() {} };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-codex-schema-"));
  const schemaPath = path.join(tempDir, "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(options.outputSchema), "utf8");
  return {
    args: buildCodexArgs(mode, { ...options, outputSchemaPath: schemaPath }),
    cleanup() { fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

// Windows 的 child.kill() 不會遞迴終止子程序；Codex timeout 時若留下 command runner，
// 舊任務可能在 worker 重試後繼續寫入目標專案。taskkill /T 以 Codex PID 為根終止整棵樹。
function terminateProcessTree(child) {
  if (process.platform === "win32" && child && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return;
  }
  if (child && typeof child.kill === "function") child.kill();
}

async function runCodex(prompt, options = {}) {
  const mode = options.mode || "execute";
  const timeoutMs = options.timeoutMs || defaultTimeoutMs(mode);
  const spawnFn = options.spawnFn || spawn;
  const terminateFn = options.terminateFn || terminateProcessTree;
  const runtime = await preflightCodexRuntime({
    command: options.command,
    runtimeOps: options.runtimeOps,
  });
  const invocation = prepareInvocation(mode, options);

  try {
    return await new Promise((resolve, reject) => {
      const child = spawnFn(runtime.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        terminateFn(child);
        finish(reject, new Error(`Codex CLI timeout(${timeoutMs}ms)`));
      }, timeoutMs);

      child.on("error", (err) => finish(reject, err));
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(reject, new Error(`Codex CLI exit ${code}: ${diagnostic(stderr, stdout)}`));
          return;
        }
        if (options.persistSession || options.resumeSessionId) {
          try {
            finish(resolve, parseCodexJsonl(stdout, options.resumeSessionId));
          } catch (error) {
            finish(reject, error);
          }
          return;
        }
        finish(resolve, stdout);
      });
      child.stdin.write(String(prompt || ""));
      child.stdin.end();
    });
  } finally {
    invocation.cleanup();
  }
}

async function deleteCodexSession(sessionId, options = {}) {
  sessionId = requireSessionId(sessionId);
  const timeoutMs = options.timeoutMs || 15000;
  const spawnFn = options.spawnFn || spawn;
  const terminateFn = options.terminateFn || terminateProcessTree;
  const pathExists = options.pathExists || (async (filePath) => {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  });
  const runtime = await preflightCodexRuntime({
    command: options.command,
    runtimeOps: options.runtimeOps,
  });
  return new Promise((resolve, reject) => {
    const child = spawnFn(runtime.command, ["app-server", "--stdio"], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });
    const INITIALIZE_ID = 1;
    const DELETE_ID = 2;
    const READ_ID = 3;
    let stdoutBuffer = "";
    let stderr = "";
    let deleteError = null;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      fn(value);
    };
    const rpcError = (value) => {
      const message = value && value.message ? value.message : JSON.stringify(value || {});
      return new Error(`Codex thread/delete 失敗: ${String(message).slice(0, 500)}`);
    };
    const send = (message) => {
      if (settled) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const handleMessage = async (message) => {
      if (!message || typeof message !== "object" || settled) return;
      if (message.id === INITIALIZE_ID) {
        if (message.error) {
          finish(reject, rpcError(message.error));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "thread/delete", id: DELETE_ID, params: { threadId: sessionId } });
        return;
      }
      if (message.id === DELETE_ID) {
        if (!message.error) {
          finish(resolve, { deleted: true, metadataDeleted: true });
          return;
        }
        deleteError = rpcError(message.error);
        send({
          method: "thread/read",
          id: READ_ID,
          params: { threadId: sessionId, includeTurns: false },
        });
        return;
      }
      if (message.id !== READ_ID || !deleteError) return;
      if (message.error) {
        const readMessage = String(message.error.message || "");
        if (/not found|missing|does not exist/i.test(readMessage)) {
          finish(resolve, { deleted: true, metadataDeleted: true });
        } else {
          finish(reject, deleteError);
        }
        return;
      }
      const thread = message.result && message.result.thread;
      const rolloutPath = thread && thread.path;
      if (!thread || thread.id !== sessionId || typeof rolloutPath !== "string" ||
          !path.basename(rolloutPath).includes(sessionId)) {
        finish(reject, deleteError);
        return;
      }
      try {
        if (await pathExists(rolloutPath)) {
          finish(reject, deleteError);
          return;
        }
        finish(resolve, {
          deleted: true,
          metadataDeleted: false,
          warning: deleteError.message,
        });
      } catch (error) {
        finish(reject, new Error(`${deleteError.message}; 無法確認 rollout: ${error.message}`));
      }
    };
    const timer = setTimeout(() => {
      terminateFn(child);
      finish(reject, new Error(`Codex session delete timeout(${timeoutMs}ms)`));
    }, timeoutMs);
    child.on("error", (error) => finish(reject, error));
    child.stdin.on("error", (error) => finish(reject, error));
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finish(reject, new Error(`Codex app-server JSONL 不合法: ${error.message}`));
          return;
        }
        Promise.resolve(handleMessage(message)).catch((error) => finish(reject, error));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (!settled) {
        finish(reject, new Error(`Codex app-server 提前結束(${code}): ${diagnostic(stderr, stdoutBuffer)}`));
      }
    });
    send({
      method: "initialize",
      id: INITIALIZE_ID,
      params: {
        clientInfo: {
          name: "element_bot",
          title: "element-bot",
          version: "1.0.0",
        },
      },
    });
  });
}

module.exports = {
  buildCodexArgs,
  deleteCodexSession,
  defaultTimeoutMs,
  preflightCodexRuntime,
  runCodex,
};
