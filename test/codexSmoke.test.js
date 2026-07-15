"use strict";
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCodex } = require("../src/codexRunner");
const { parseTaskResult, schemaForMode } = require("../src/executors/taskResult");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-codex-smoke-"));

(async () => {
  try {
    const init = spawnSync("git", ["init", "-q"], { cwd: tempDir, encoding: "utf8" });
    assert.strictEqual(init.status, 0, init.stderr || "無法建立 smoke-test Git repository");
    fs.writeFileSync(path.join(tempDir, "codex-smoke-marker.txt"), "ELEMENT_BOT_ALREADY_DONE\n", "utf8");
    const output = await runCodex([
      "這是已核准的無人值守 smoke test。",
      "讀取既有 codex-smoke-marker.txt；它代表任務早已完成。",
      "不得修改、新增或刪除任何檔案。",
      "回報 success，並在 output 說明已找到 marker、無需重複操作。",
    ].join("\n"), {
      mode: "execute",
      cwd: tempDir,
      timeoutMs: 600000,
      outputSchema: schemaForMode("generic"),
    });
    const result = parseTaskResult(output, "generic");
    assert.strictEqual(result.status, "success");
    assert.match(result.output, /marker|無需|完成/i);
    assert.deepStrictEqual(
      fs.readdirSync(tempDir).filter((name) => name !== ".git").sort(),
      ["codex-smoke-marker.txt"]
    );

    console.log("codexSmoke.test.js: 真實 Codex generic no-op success/output 通過 ✅");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
