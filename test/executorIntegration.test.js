"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { agentExecutor, readLogLines } = require("../src/executors/agentExecutor");
const { readState } = require("../src/executors/checkpoint");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const d = path.join(os.tmpdir(), `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 用真實通用 taskDef；sourceDir 只組路徑、不真存取，假 ops 不會碰磁碟。
const TASK = { task: "skill-dispatch", project_path: "D:\\GB\\sample-app", command: "把背景改成紅色" };
const findSummary = (lines) => lines.find((o) => typeof o.status === "string" && !o.step && !o.steps);
const codexResult = JSON.stringify({
  status: "success", output: "背景已經是紅色，不需重複修改。",
});

(async () => {
  // 全新任務跑完整鏈(真實 handlers + 假 ops):Codex 結構化結果直接驅動 summary
  {
    const q = freshQueue();
    const calls = [];
    const ops = {
      gitHead: () => { calls.push("head"); return "abc"; },
      resultMode: () => { calls.push("mode"); return "generic"; },
      runCodex: (prompt, _src, mode) => {
        calls.push("codex");
        ok("完整鏈使用 generic prompt 與 mode", prompt.includes("無人值守") && mode === "generic");
        return codexResult;
      },
    };
    await agentExecutor(TASK, { queueDir: q, id: "f1", logger: silentLogger, ops });
    ok("generic 完整鏈不讀 HEAD，只選一次模式並派一次 Codex", calls.join(",") === "mode,codex");
    const summary = findSummary(readLogLines(q, "f1"));
    ok("summary success", summary && summary.status === "success");
    ok("generic summary 不捏造改動檔", summary && Array.isArray(summary.produced) && summary.produced.length === 0);
    const st = readState(path.join(q, "work", "f1"));
    ok("state 全 ok", st && Object.values(st.steps).every((v) => v === "ok"));
    fs.rmSync(q, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  // 中斷續跑:state 預seed prepare ok → 跳過 prepare,ai_run 重跑 Codex
  {
    const q = freshQueue();
    const workDir = path.join(q, "work", "f2");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "state.json"),
      JSON.stringify({ id: "f2", steps: { prepare: "ok", ai_run: "pending", verify: "pending", summarize: "pending" }, attempt: 1 }), "utf8");
    const calls = [];
    const ops = {
      gitHead: () => { calls.push("head"); return "abc"; },
      resultMode: () => { calls.push("mode"); return "generic"; },
      runCodex: () => { calls.push("codex"); return codexResult; },
    };
    await agentExecutor(TASK, { queueDir: q, id: "f2", logger: silentLogger, ops });
    ok("續跑跳過 prepare(不再讀 HEAD)", !calls.includes("head"));
    ok("續跑重跑 ai_run(codex 被呼叫)", calls.includes("codex"));
    ok("續跑仍出 success summary", (findSummary(readLogLines(q, "f2")) || {}).status === "success");
    fs.rmSync(q, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  console.log(`executorIntegration.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
