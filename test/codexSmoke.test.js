"use strict";
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCodex } = require("../src/codexRunner");
const { parseTaskResult, TASK_RESULT_SCHEMA } = require("../src/executors/taskResult");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-codex-smoke-"));
function git(args) {
  const result = spawnSync("git", args, { cwd: tempDir, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(" ")} 失敗`);
  return String(result.stdout || "").trim();
}

(async () => {
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "element-bot smoke"]);
    git(["config", "user.email", "element-bot-smoke@example.invalid"]);
    const markerPath = path.join(tempDir, "codex-smoke-marker.txt");
    const markerContent = "ELEMENT_BOT_ALREADY_DONE\n";
    fs.writeFileSync(markerPath, markerContent, "utf8");
    git(["add", "codex-smoke-marker.txt"]);
    git(["commit", "-q", "-m", "test: baseline marker"]);
    const baselineHead = git(["rev-parse", "HEAD"]);

    const output = await runCodex([
      "這是已核准的無人值守 smoke test。",
      "讀取既有 codex-smoke-marker.txt；它代表任務早已完成。",
      "不得修改、新增或刪除任何檔案。",
      "回報 success，並在 output 說明已找到 marker、無需重複操作。",
    ].join("\n"), {
      mode: "execute",
      cwd: tempDir,
      timeoutMs: 600000,
      outputSchema: TASK_RESULT_SCHEMA,
    });
    const result = parseTaskResult(output);
    assert.strictEqual(result.status, "success");
    assert.match(result.output, /marker|無需|完成/i);
    assert.strictEqual(fs.readFileSync(markerPath, "utf8"), markerContent);
    assert.strictEqual(git(["rev-parse", "HEAD"]), baselineHead);
    assert.strictEqual(git(["status", "--porcelain"]), "");
    assert.deepStrictEqual(
      fs.readdirSync(tempDir).filter((name) => name !== ".git").sort(),
      ["codex-smoke-marker.txt"]
    );

    console.log("codexSmoke.test.js: 真實 Codex generic no-op success/output 通過 ✅");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
