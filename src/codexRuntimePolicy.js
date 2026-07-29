"use strict";

function blocked(stage, detail) {
  const error = new Error(`Codex runtime blocked: ${stage}：${detail}`);
  error.code = "CODEX_RUNTIME_BLOCKED";
  error.stage = stage;
  return error;
}

function validateCodexVersion(output) {
  const version = String(output || "").trim();
  if (!/^codex-cli(?:\s|$)/.test(version)) {
    throw blocked("版本", "找到的程式不是 OpenAI Codex CLI");
  }
  return version;
}

function validateChatGptLogin(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chatGptLines = lines.filter(
    (line) => line === "Logged in using ChatGPT",
  );
  const conflicting = lines.some((line) =>
    /API key|Not logged in/i.test(line),
  );
  if (chatGptLines.length !== 1 || conflicting) {
    throw blocked("登入", "必須使用此裝置已登入的 ChatGPT 帳號");
  }
  return "ChatGPT";
}

function validateWindowsSignature(signature) {
  const status = signature && String(signature.status || "");
  const signer = signature && String(signature.signer || "");
  if (status !== "Valid" || !signer.includes("OpenAI OpCo, LLC")) {
    throw blocked("簽章", "Windows 執行檔必須具有有效的 OpenAI 數位簽章");
  }
  return "OpenAI OpCo, LLC";
}

function unquoteTomlValue(value) {
  const withoutComment = String(value || "").split("#", 1)[0].trim();
  if (
    withoutComment.length >= 2 &&
    ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
      (withoutComment.startsWith("'") && withoutComment.endsWith("'")))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function findUnsafeCodexConfig(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^(?:openai_base_url|chatgpt_base_url)\s*=/.test(trimmed)) {
      return "base URL 覆寫";
    }
    if (/^profile\s*=/.test(trimmed) || /^\[profiles(?:\.|\])/.test(trimmed)) {
      return "profile 覆寫";
    }
    const provider = trimmed.match(/^model_provider\s*=\s*(.+)$/);
    if (provider && unquoteTomlValue(provider[1]) !== "openai") {
      return "非 openai provider";
    }
  }
  return null;
}

module.exports = {
  blocked,
  validateCodexVersion,
  validateChatGptLogin,
  validateWindowsSignature,
  findUnsafeCodexConfig,
};
