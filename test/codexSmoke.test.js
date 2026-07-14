"use strict";
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCodex } = require("../src/codexRunner");
const { TASK_RESULT_SCHEMA, parseTaskResult } = require("../src/executors/taskResult");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-codex-smoke-"));

(async () => {
  try {
    const init = spawnSync("git", ["init", "-q"], { cwd: tempDir, encoding: "utf8" });
    assert.strictEqual(init.status, 0, init.stderr || "無法建立 smoke-test Git repository");

    const readOutput = await runCodex(
      "這是唯讀連通測試。不要建立或修改檔案，只回覆 ELEMENT_BOT_CODEX_READ_OK。",
      { mode: "probe", cwd: tempDir, timeoutMs: 300000 }
    );
    assert.match(readOutput, /ELEMENT_BOT_CODEX_READ_OK/);
    assert.deepStrictEqual(
      fs.readdirSync(tempDir).filter((name) => name !== ".git"),
      [],
      "read-only smoke test 不得產生檔案"
    );

    const executeOutput = await runCodex(
      [
        "在目前專案根目錄建立 codex-smoke.txt。",
        "檔案內容必須精確為 ELEMENT_BOT_CODEX_WRITE_OK（可有結尾換行）。",
        "除此之外不要建立或修改其他檔案。",
        "最後依指定 schema 回報 success，changes 填 codex-smoke.txt，其餘陣列可為空。",
      ].join("\n"),
      { mode: "execute", cwd: tempDir, timeoutMs: 600000, outputSchema: TASK_RESULT_SCHEMA }
    );
    const result = parseTaskResult(executeOutput);
    const smokePath = path.join(tempDir, "codex-smoke.txt");
    assert.ok(fs.existsSync(smokePath), "autonomous execute smoke test 未建立指定檔案");
    assert.strictEqual(fs.readFileSync(smokePath, "utf8").trim(), "ELEMENT_BOT_CODEX_WRITE_OK");
    assert.strictEqual(result.status, "success");
    assert.ok(result.changes.includes("codex-smoke.txt"));

    console.log("codexSmoke.test.js: 真實 Codex read-only/autonomous execute/structured result 通過 ✅");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
