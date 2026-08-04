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
  args.push(
    "exec",
    "--ephemeral",
    "--sandbox", config.sandbox,
    "--color", "never"
  );
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
        if (code === 0) finish(resolve, stdout);
        else finish(reject, new Error(`Codex CLI exit ${code}: ${diagnostic(stderr, stdout)}`));
      });
      child.stdin.write(String(prompt || ""));
      child.stdin.end();
    });
  } finally {
    invocation.cleanup();
  }
}

module.exports = {
  buildCodexArgs,
  defaultTimeoutMs,
  preflightCodexRuntime,
  runCodex,
};
