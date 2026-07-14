"use strict";
const assert = require("assert");
const { runProbe, probeRule } = require("../src/probe");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

(async () => {
  {
    let seenPrompt = "";
    let seenDir = "";
    const result = await runProbe("D:\\P", "/do work", {
      runner: async (prompt, projectDir) => {
        seenPrompt = prompt;
        seenDir = projectDir;
        return { ok: true, output: "ok" };
      },
    });
    ok("probe 將目標專案作為 cwd", seenDir === "D:\\P");
    ok("probe 保留收到的 command", seenPrompt.includes("/do work"));
    ok("probe 交由目標專案自身設定決定流程", seenPrompt.includes("目標專案自身"));
    for (const forbidden of [".claude/skills", ".agents/skills", ".cursor/skills"]) {
      ok(`probe 不指定 ${forbidden}`, !seenPrompt.includes(forbidden));
    }
    ok("probe 回傳 runner 結果", result.output === "ok");
  }

  // use_llm 規則:judge 抽參 → 填指令 → 呼叫探測
  {
    let probedWith = null;
    const rule = { use_llm: true, intent: "x", extract: ["目標"], project_path: "D:\\P", command: "啟動 {目標}" };
    const res = await probeRule(rule, "打開 A", {
      judgeFn: async () => ({ trigger: true, params: { 目標: "A" } }),
      probeFn: async (dir, cmd) => { probedWith = { dir, cmd }; return { ok: true, output: "我在 D:\\P" }; },
    });
    ok("LLM 觸發 → trigger true", res.trigger === true);
    ok("抽出 params", res.params.目標 === "A");
    ok("指令用 params 填好", res.rendered_command === "啟動 A");
    ok("探測用填好的指令 + 專案路徑", probedWith.cmd === "啟動 A" && probedWith.dir === "D:\\P");
    ok("回傳探測輸出", res.probe && res.probe.output.includes("我在"));
  }

  // LLM 判定不觸發 → 不呼叫探測
  {
    let called = false;
    const rule = { use_llm: true, intent: "x", extract: ["目標"], project_path: "D:\\P", command: "啟動 {目標}" };
    const res = await probeRule(rule, "隨便講講", {
      judgeFn: async () => ({ trigger: false, params: {} }),
      probeFn: async () => { called = true; return {}; },
    });
    ok("LLM 不觸發 → trigger false", res.trigger === false);
    ok("不觸發則不派 claude 探測", called === false && res.probe === null);
  }

  // 固定指令(use_llm false):不 judge,指令原樣,直接探測
  {
    let called = false;
    const rule = { use_llm: false, project_path: "D:\\P", command: "啟動" };
    const res = await probeRule(rule, "幫我啟動", {
      judgeFn: async () => { throw new Error("不該 judge"); },
      probeFn: async (dir, cmd) => { called = true; return { ok: true, output: cmd }; },
    });
    ok("固定指令不跑 judge", called === true);
    ok("固定指令原樣送出", res.rendered_command === "啟動");
  }

  console.log(`probe.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
