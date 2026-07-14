"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { reloadRules, watchRules } = require("../src/rulesWatcher");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function fakeLogger() {
  const c = { log: [], warn: [] };
  return { log: (m) => c.log.push(m), warn: (m) => c.warn.push(m), _c: c };
}
function freshDir() {
  const d = path.join(os.tmpdir(), `rw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function waitFor(pred, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
}

const good = { name: "改顏色", keywords: ["改顏色"], task: "test-task", use_llm: false };
const good2 = { name: "回答", keywords: ["回答"], task: "test-task", use_llm: false };

(async () => {
  // reloadRules:好檔回新規則並 log
  {
    const dir = freshDir();
    const rp = path.join(dir, "rules.json");
    fs.writeFileSync(rp, JSON.stringify([good, good2]), "utf8");
    const lg = fakeLogger();
    const out = reloadRules(rp, [], lg);
    ok("reloadRules 好檔回新規則", out.length === 2 && out[1].name === "回答");
    ok("reloadRules 成功有 log", lg._c.log.length === 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // reloadRules:壞檔保留舊規則並 warn(不丟錯)
  {
    const dir = freshDir();
    const rp = path.join(dir, "rules.json");
    fs.writeFileSync(rp, "{ 壞掉的 json", "utf8");
    const lg = fakeLogger();
    const current = [good];
    const out = reloadRules(rp, current, lg);
    ok("reloadRules 壞檔回原規則(同參考)", out === current);
    ok("reloadRules 失敗有 warn", lg._c.warn.length === 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // reloadRules:檔存在但規則不合法 → 一樣保留舊
  {
    const dir = freshDir();
    const rp = path.join(dir, "rules.json");
    fs.writeFileSync(rp, JSON.stringify([{ name: "" }]), "utf8");
    const lg = fakeLogger();
    const current = [good, good2];
    const out = reloadRules(rp, current, lg);
    ok("reloadRules 非法規則保留舊", out === current && lg._c.warn.length === 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // watchRules:偵測檔案變動並觸發 onChange(輪詢避免 timing flaky)
  {
    const dir = freshDir();
    const rp = path.join(dir, "rules.json");
    fs.writeFileSync(rp, JSON.stringify([good]), "utf8");
    let fired = 0;
    const w = watchRules(rp, () => { fired++; }, { debounceMs: 50 });
    fs.writeFileSync(rp, JSON.stringify([good, good2]), "utf8");
    const seen = await waitFor(() => fired > 0, 3000);
    ok("watchRules 偵測變動並觸發 onChange", seen && fired > 0);
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`rulesWatcher.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
