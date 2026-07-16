"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { agentExecutor, readLogLines } = require("../src/executors/agentExecutor");
const { readState } = require("../src/executors/checkpoint");

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; }
const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const dir = path.join(os.tmpdir(), `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TASK = { task: "skill-dispatch", project_path: "D:\\GB\\sample-app", command: "把背景改成紅色" };
const CODEX_RESULT = JSON.stringify({ status: "success", output: "背景已經是紅色，不需重複修改。" });
const findSummary = (lines) => lines.find((entry) => typeof entry.status === "string" && !entry.step && !entry.steps);

(async () => {
  {
    const queueDir = freshQueue();
    const calls = [];
    const ops = {
      runCodex: (prompt, sourceDir) => {
        calls.push("codex");
        ok("完整鏈使用 generic prompt", prompt.includes("無人值守") && prompt.includes("完整 output"));
        ok("完整鏈使用規則目標路徑", sourceDir.endsWith("sample-app"));
        return CODEX_RESULT;
      },
    };
    await agentExecutor(TASK, { queueDir, id: "f1", logger: silentLogger, ops });
    ok("完整鏈只派一次 Codex", calls.join(",") === "codex");
    const summary = findSummary(readLogLines(queueDir, "f1"));
    ok("summary success", summary && summary.status === "success");
    ok("summary 不捏造改動檔", summary && Array.isArray(summary.produced) && summary.produced.length === 0);
    const state = readState(path.join(queueDir, "work", "f1"));
    ok("state 全部完成", state && Object.values(state.steps).every((value) => value === "ok"));
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    const workDir = path.join(queueDir, "work", "f2");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "state.json"), JSON.stringify({
      id: "f2",
      steps: { prepare: "ok", ai_run: "pending", verify: "pending", summarize: "pending" },
      attempt: 1,
    }), "utf8");
    const calls = [];
    await agentExecutor(TASK, {
      queueDir,
      id: "f2",
      logger: silentLogger,
      ops: { runCodex: () => { calls.push("codex"); return CODEX_RESULT; } },
    });
    ok("續跑會重新派發 Codex", calls.join(",") === "codex");
    ok("續跑仍產生 success summary", (findSummary(readLogLines(queueDir, "f2")) || {}).status === "success");
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  {
    const queueDir = freshQueue();
    const workDir = path.join(queueDir, "work", "f3");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "state.json"), JSON.stringify({
      id: "f3",
      steps: { prepare: "ok", ai_run: "ok", verify: "ok", summarize: "ok" },
      attempt: 1,
    }), "utf8");
    fs.writeFileSync(path.join(workDir, "task-result.json"), JSON.stringify({
      status: "blocked",
      output: "缺少必要的新圖片。",
    }), "utf8");

    const summary = await agentExecutor(TASK, {
      queueDir,
      id: "f3",
      logger: silentLogger,
      ops: { runCodex: () => { throw new Error("所有步驟完成時不應重跑 Codex"); } },
    });

    ok("全部步驟已完成時還原 blocked 狀態", summary && summary.queueStatus === "blocked");
    ok("還原結果保留原始 output", summary && summary.output === "缺少必要的新圖片。");
    fs.rmSync(queueDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  console.log(`executorIntegration.test.js: ${passed} 項通過 ✅`);
})().catch((error) => { console.error(error); process.exit(1); });
