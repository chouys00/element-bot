"use strict";
const fs = require("fs");
const path = require("path");
const { ensureDir, readJsonSafe, writeJsonAtomic } = require("./fsUtils");

// LLM 判斷狀態的落地紀錄:讓 dashboard 分得清「沒收到 / LLM 判斷中 / LLM 判定不觸發 / 判斷失敗」。
//  - 判斷開始:寫 queue/judging/<id>.json(形狀同任務檔,dashboard 任務列表直接顯示「LLM 判斷中」)
//  - 判定觸發:刪 judging 檔(任務本身已進 pending/,不重複顯示)
//  - 判定不觸發 / 判斷失敗:搬到 queue/judged/<id>.json 留紀錄(否則使用者只看得到「沒任務」)
// judged/ 只保留最近 JUDGED_KEEP 筆,避免無限增長。

const JUDGED_KEEP = 50;

// 開始 LLM 判斷。回傳紀錄 id(finishJudging 用)。
function startJudging(queueDir, rule, rec) {
  const dir = ensureDir(path.join(queueDir, "judging"));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const safeRule = String(rule.name || "rule").replace(/[^a-zA-Z0-9_-]/g, "_");
  const id = `${ts}-${safeRule}-${rand}`;
  writeJsonAtomic(path.join(dir, id + ".json"), {
    rule: rule.name,
    task: rule.task,
    source: {
      room_id: rec && rec.room_id,
      sender: rec && rec.sender,
      event_id: rec && rec.event_id,
      body: rec && rec.content && rec.content.body,
    },
    enqueued_at: new Date().toISOString(),
    judge: { status: "judging" },
  });
  return id;
}

// 結束 LLM 判斷。outcome = { result: "triggered"|"rejected"|"error", detail? }。
function finishJudging(queueDir, id, outcome) {
  const from = path.join(queueDir, "judging", id + ".json");
  const record = readJsonSafe(from, null);
  try { fs.rmSync(from, { force: true }); } catch (_) {}
  const result = outcome && outcome.result;
  if (result === "triggered" || !record) return; // 觸發:任務已入列,判斷紀錄功成身退
  record.judge = {
    status: result === "error" ? "error" : "rejected",
    detail: (outcome && outcome.detail) || null,
    finished_at: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(ensureDir(path.join(queueDir, "judged")), id + ".json"), record);
  pruneJudged(queueDir);
}

// 修剪 judged/:檔名以時間戳開頭,字典序即時間序,刪最舊的超額檔。
function pruneJudged(queueDir, keep = JUDGED_KEEP) {
  const dir = path.join(queueDir, "judged");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); }
  catch (_) { return; }
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) {}
  }
}

module.exports = { startJudging, finishJudging, pruneJudged, JUDGED_KEEP };
