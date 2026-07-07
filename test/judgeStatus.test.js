"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startJudging, finishJudging, pruneJudged } = require("../src/judgeStatus");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

const rule = { name: "測試規則", task: "skill-dispatch" };
const rec = { room_id: "!r:s", sender: "@a:s", event_id: "$e", content: { body: "日常修改 xxx" } };

function tmpQueue() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "judge-status-"));
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

(async () => {
  // startJudging:寫 judging/<id>.json,形狀同任務檔 + judge.status=judging
  {
    const q = tmpQueue();
    const id = startJudging(q, rule, rec);
    const file = path.join(q, "judging", id + ".json");
    ok("startJudging 寫入 judging 檔", fs.existsSync(file));
    const o = readJson(file);
    ok("紀錄帶 rule/task", o.rule === "測試規則" && o.task === "skill-dispatch");
    ok("紀錄帶 source.body", o.source.body === "日常修改 xxx");
    ok("紀錄標示判斷中", o.judge.status === "judging");
    ok("id 不含不安全字元", /^[A-Za-z0-9_-]+$/.test(id));
  }

  // finishJudging triggered:刪 judging 檔、不留 judged 紀錄(任務本身已入列)
  {
    const q = tmpQueue();
    const id = startJudging(q, rule, rec);
    finishJudging(q, id, { result: "triggered" });
    ok("triggered 後 judging 檔已刪", !fs.existsSync(path.join(q, "judging", id + ".json")));
    ok("triggered 不留 judged 紀錄", !fs.existsSync(path.join(q, "judged", id + ".json")));
  }

  // finishJudging rejected:搬到 judged/,標 rejected
  {
    const q = tmpQueue();
    const id = startJudging(q, rule, rec);
    finishJudging(q, id, { result: "rejected" });
    ok("rejected 後 judging 檔已刪", !fs.existsSync(path.join(q, "judging", id + ".json")));
    const o = readJson(path.join(q, "judged", id + ".json"));
    ok("rejected 紀錄留在 judged/", o.judge.status === "rejected");
    ok("rejected 紀錄保留 source", o.source.body === "日常修改 xxx");
  }

  // finishJudging error:標 error 並帶 detail
  {
    const q = tmpQueue();
    const id = startJudging(q, rule, rec);
    finishJudging(q, id, { result: "error", detail: "claude CLI timeout(120000ms)" });
    const o = readJson(path.join(q, "judged", id + ".json"));
    ok("error 紀錄標 error", o.judge.status === "error");
    ok("error 紀錄帶原因", o.judge.detail.includes("timeout"));
  }

  // finishJudging 對不存在的 id 不丟錯
  {
    const q = tmpQueue();
    finishJudging(q, "no-such-id", { result: "rejected" });
    ok("不存在的 id 靜默略過", true);
  }

  // pruneJudged:只留最新 keep 筆(檔名時間戳字典序)
  {
    const q = tmpQueue();
    const dir = path.join(q, "judged");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `2026-01-0${i + 1}T00-00-00-000Z-r-x${i}.json`), "{}", "utf8");
    pruneJudged(q, 2);
    const left = fs.readdirSync(dir).sort();
    ok("pruneJudged 留最新 2 筆", left.length === 2 && left[0].startsWith("2026-01-04") && left[1].startsWith("2026-01-05"));
  }

  console.log(`judgeStatus.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
