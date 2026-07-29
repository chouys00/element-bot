"use strict";

const assert = require("assert");
const {
  validateCodexVersion,
  validateChatGptLogin,
  validateWindowsSignature,
  findUnsafeCodexConfig,
} = require("../src/codexRuntimePolicy");

let passed = 0;

function passes(name, fn) {
  fn();
  passed++;
}

function blocked(name, fn, pattern) {
  assert.throws(fn, pattern, name);
  passed++;
}

passes("接受 codex-cli 版本輸出", () => {
  assert.strictEqual(
    validateCodexVersion("codex-cli 0.144.3\n"),
    "codex-cli 0.144.3",
  );
});

for (const output of ["cursor 1.0", "claude 2.0", "", "codex 0.1"]) {
  blocked(
    `拒絕非 Codex CLI 版本：${output || "空輸出"}`,
    () => validateCodexVersion(output),
    /Codex runtime blocked:.*版本/,
  );
}

passes("只接受 ChatGPT 登入", () => {
  assert.strictEqual(
    validateChatGptLogin("Logged in using ChatGPT\n"),
    "ChatGPT",
  );
});

for (const output of [
  "Logged in using an API key",
  "Not logged in",
  "",
  "Logged in using ChatGPT\nLogged in using an API key",
  "Logged in using ChatGPT\nLogged in using ChatGPT",
]) {
  blocked(
    `拒絕不合格登入：${output || "空輸出"}`,
    () => validateChatGptLogin(output),
    /Codex runtime blocked:.*登入/,
  );
}

passes("接受 OpenAI 的有效 Windows 簽章", () => {
  assert.strictEqual(
    validateWindowsSignature({
      status: "Valid",
      signer: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"',
    }),
    "OpenAI OpCo, LLC",
  );
});

for (const signature of [
  { status: "NotSigned", signer: "" },
  { status: "HashMismatch", signer: 'CN="OpenAI OpCo, LLC"' },
  { status: "Valid", signer: "Cursor Inc." },
  { status: "Valid", signer: "Anthropic PBC" },
  null,
]) {
  blocked(
    "拒絕非 OpenAI 有效簽章",
    () => validateWindowsSignature(signature),
    /Codex runtime blocked:.*簽章/,
  );
}

for (const config of [
  "",
  'model = "gpt-5.6-sol"\n',
  '# model_provider = "mistral"\nmodel_provider = "openai"\n',
  '[model_providers.mistral]\nbase_url = "https://api.mistral.ai"\n',
]) {
  passes("接受不改變內建 OpenAI provider 的設定", () => {
    assert.strictEqual(findUnsafeCodexConfig(config), null);
  });
}

for (const [config, expected] of [
  ['model_provider = "mistral"', /provider/i],
  ['model_provider = "amazon-bedrock"', /provider/i],
  ['openai_base_url = "https://proxy.example.com"', /base URL/i],
  ['chatgpt_base_url = "https://proxy.example.com"', /base URL/i],
  ['profile = "paid"', /profile/i],
  ["[profiles.paid]", /profile/i],
]) {
  passes("找出會改變 Codex 來源的使用者設定", () => {
    assert.match(findUnsafeCodexConfig(config), expected);
  });
}

console.log(`codexRuntimePolicy.test.js: ${passed} 項通過 ✅`);
