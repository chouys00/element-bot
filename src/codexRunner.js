"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MODE_CONFIG = Object.freeze({
  judge: { sandbox: "read-only", network: false },
  probe: { sandbox: "read-only", network: false },
  execute: { sandbox: "workspace-write", network: true },
});

function buildCodexArgs(mode, options = {}) {
  const config = MODE_CONFIG[mode];
  if (!config) throw new Error(`未知的 Codex mode: ${mode}`);

  const args = ["--ask-for-approval", "never"];
  if (config.network) {
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

function runCodex(prompt, options = {}) {
  const mode = options.mode || "execute";
  const timeoutMs = options.timeoutMs || 120000;
  const spawnFn = options.spawnFn || spawn;
  const command = options.command || process.env.CODEX_COMMAND || "codex";
  const invocation = prepareInvocation(mode, options);

  return new Promise((resolve, reject) => {
    const child = spawnFn(command, invocation.args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
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
      child.kill();
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
  }).finally(invocation.cleanup);
}

function runCodexSync(prompt, options = {}) {
  const mode = options.mode || "execute";
  const timeoutMs = options.timeoutMs || parseInt(process.env.AI_TIMEOUT_MS || "1800000", 10);
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const command = options.command || process.env.CODEX_COMMAND || "codex";
  const invocation = prepareInvocation(mode, options);
  try {
    const result = spawnSyncFn(command, invocation.args, {
      input: String(prompt || ""),
      cwd: options.cwd,
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
      timeout: timeoutMs,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Codex CLI exit ${result.status}: ${diagnostic(result.stderr, result.stdout)}`);
    }
    return String(result.stdout || "");
  } finally {
    invocation.cleanup();
  }
}

module.exports = { buildCodexArgs, runCodex, runCodexSync };
