"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { collectTasks, statusCounts, readMessagesTail, resolveTaskLog, parseProgress, isVerified } = require("../src/dashboard/aggregate");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

function freshRoot() {
  const d = path.join(os.tmpdir(), `agg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  for (const s of ["pending", "processing", "done", "failed", "blocked", "review", "logs"]) fs.mkdirSync(path.join(d, "queue", s), { recursive: true });
  fs.mkdirSync(path.join(d, "output"), { recursive: true });
  return d;
}
function writeTask(queueDir, status, name, obj) {
  fs.writeFileSync(path.join(queueDir, status, name), JSON.stringify(obj), "utf8");
}

const root = freshRoot();
const queueDir = path.join(root, "queue");
const rooms = { "!r:s": "產品群" };

writeTask(queueDir, "done", "t1.json", { rule: "會議", task: "cal", enqueued_at: "2026-06-26T01:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "hi", event_id: "$1" } });
writeTask(queueDir, "pending", "t2.json", { rule: "退款", task: "ticket", enqueued_at: "2026-06-26T02:00:00.000Z", source: { room_id: "!x:s", sender: "@b", body: "refund", event_id: "$2" } });
writeTask(queueDir, "processing", "t3.json", {
  rule: "禪道派工", task: "skill-dispatch", enqueued_at: "2026-06-26T02:30:00.000Z",
  project_path: "D:\\GB\\PC\\ftl\\ftl", command: "https://zentao.gbboss.com/bug-view-1",
  source: { room_id: "!r:s", sender: "@a", body: "日常修改 x", event_id: "$5" },
});
fs.writeFileSync(path.join(queueDir, "failed", "bad.json"), "{ not json", "utf8");

const tasks = collectTasks(queueDir, rooms, 100);
ok("收齊四筆(含壞檔)", tasks.length === 4);
ok("依 enqueued_at 新到舊", tasks[0].id === "t3" && tasks[1].id === "t2" && tasks[2].id === "t1");
const t3 = tasks.find((t) => t.id === "t3");
ok("skill-dispatch 帶出 project_path", t3.project_path === "D:\\GB\\PC\\ftl\\ftl");
ok("skill-dispatch 帶出 command", t3.command === "https://zentao.gbboss.com/bug-view-1");
ok("非 skill-dispatch 任務不帶 project_path", tasks.find((t) => t.id === "t1").project_path === undefined);
ok("done 任務翻出房間名稱", tasks.find((t) => t.id === "t1").room_name === "產品群");
ok("無名稱回退 id", tasks.find((t) => t.id === "t2").room_name === "!x:s");
ok("壞檔標記 parseError", tasks.some((t) => t.parseError === true));
ok("limit 生效", collectTasks(queueDir, rooms, 1).length === 1);

{
  const numberedRoot = freshRoot();
  const numberedQueue = path.join(numberedRoot, "queue");
  const internalId = "2026-07-16T03-49-46-175Z-____-q3fnoi";
  writeTask(numberedQueue, "done", `${internalId}.json`, {
    rule: "測試",
    task: "skill-dispatch",
    enqueued_at: "2026-07-16T03:49:46.175Z",
    source: {},
  });
  const numberedTask = collectTasks(numberedQueue, {}, 1)[0];
  ok("任務清單帶出簡短任務編號", numberedTask.task_number === "20260716-114946-q3fnoi");
  ok("任務清單保留內部完整 ID", numberedTask.id === internalId);
  fs.rmSync(numberedRoot, { recursive: true, force: true });
}

const counts = statusCounts(queueDir);
ok("狀態統計正確", counts.done === 1 && counts.pending === 1 && counts.failed === 1 && counts.processing === 1);

ok("無日誌回占位", resolveTaskLog(queueDir, "t1").source === "none");
fs.writeFileSync(path.join(queueDir, "failed", "bad.json.error.txt"), "boom", "utf8");
ok("有 error.txt 用之", resolveTaskLog(queueDir, "bad").source === "error" && resolveTaskLog(queueDir, "bad").text === "boom");
fs.writeFileSync(path.join(queueDir, "logs", "t1.log"), "ran ok", "utf8");
ok("有 log 優先", resolveTaskLog(queueDir, "t1").source === "log" && resolveTaskLog(queueDir, "t1").text === "ran ok");

fs.writeFileSync(path.join(queueDir, "logs", "with-link.log"), JSON.stringify({
  ai_output: "舊網址 https://old.example.com/\n\n驗收連結：\n- https://preview.intra.local/tasks/task-1/",
}) + "\n", "utf8");
ok(
  "progress 只擷取 output 明確標示的驗收連結",
  JSON.stringify(parseProgress(queueDir, "with-link").links) === JSON.stringify(["https://preview.intra.local/tasks/task-1/"])
);

const out = path.join(root, "output", "messages.jsonl");
fs.appendFileSync(out, JSON.stringify({ body: "m1" }) + "\n" + JSON.stringify({ body: "m2" }) + "\n", "utf8");
const msgs = readMessagesTail(out, 50);
ok("訊息尾段新到舊", msgs.length === 2 && msgs[0].body === "m2");
ok("缺檔回空陣列", readMessagesTail(path.join(root, "nope.jsonl"), 50).length === 0);

fs.mkdirSync(path.join(queueDir, "work", "t1"), { recursive: true });
fs.writeFileSync(path.join(queueDir, "work", "t1", "verified.json"), "{}", "utf8");
ok("verified 反映標記檔", collectTasks(queueDir, rooms, 100).find((t) => t.id === "t1").verified === true);
ok("未驗收為 false", collectTasks(queueDir, rooms, 100).find((t) => t.id === "t2").verified === false);

// approval outbox 狀態附回原始 done task，並與 legacy verified 分開統計。
{
  const approvalRoot = freshRoot();
  const approvalQueue = path.join(approvalRoot, "queue");
  for (const id of ["unapproved", "pending-approval", "processing-approval", "published", "publish-failed", "publish-unknown", "legacy"]) {
    writeTask(approvalQueue, "done", `${id}.json`, {
      rule: "發布", task: "skill-dispatch", project_path: "D:\\GB\\app", target_branch: "main",
      enqueued_at: "2026-07-21T01:00:00.000Z", source: {},
    });
  }
  for (const [status, id] of [["pending", "pending-approval"], ["processing", "processing-approval"], ["done", "published"], ["failed", "publish-failed"], ["unknown", "publish-unknown"]]) {
    fs.mkdirSync(path.join(approvalQueue, "approvals", status), { recursive: true });
    fs.writeFileSync(path.join(approvalQueue, "approvals", status, `${id}.json`), JSON.stringify({
      task_id: id, project_path: "D:\\GB\\app", target_branch: "main",
      approved_by: "王小明", approved_at: "2026-07-21T02:00:00.000Z", attempt: 1,
    }), "utf8");
  }
  fs.mkdirSync(path.join(approvalQueue, "work", "legacy"), { recursive: true });
  fs.writeFileSync(path.join(approvalQueue, "work", "legacy", "verified.json"), "{}", "utf8");

  const approvalTasks = collectTasks(approvalQueue, {}, 100);
  const processingApproval = approvalTasks.find((t) => t.id === "processing-approval");
  ok("task API 帶 approval 狀態與人員", processingApproval.approval.status === "processing" && processingApproval.approval.approved_by === "王小明");
  ok("提交中尚未算發布完成", processingApproval.verified === false);
  ok("approval done 算發布完成", approvalTasks.find((t) => t.id === "published").verified === true);
  ok("legacy verified 仍相容", approvalTasks.find((t) => t.id === "legacy").verified === true);

  const approvalCounts = statusCounts(approvalQueue);
  ok("approval 狀態統計分流", approvalCounts.unverified === 1 && approvalCounts.publishing === 2 && approvalCounts.publish_failed === 1 && approvalCounts.publish_unknown === 1 && approvalCounts.published === 2);
  ok("只有未核准任務列入待驗收", approvalCounts.review === 1);
  fs.rmSync(approvalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

writeTask(queueDir, "blocked", "blk.json", { rule: "禪道", task: "skill-dispatch", enqueued_at: "2026-06-26T02:40:00.000Z", source: {} });
writeTask(queueDir, "review", "part.json", { rule: "禪道", task: "skill-dispatch", enqueued_at: "2026-06-26T02:50:00.000Z", source: {} });
{
  const withResults = collectTasks(queueDir, rooms, 100);
  ok("blocked 任務進入清單", withResults.find((t) => t.id === "blk").status === "blocked");
  ok("review 任務進入清單", withResults.find((t) => t.id === "part").status === "review");
  const resultCounts = statusCounts(queueDir);
  ok("blocked/review 狀態統計正確", resultCounts.blocked === 1 && resultCounts.review === 1);
}

// ── LLM 判斷紀錄(judging/judged)進任務清單 ──
fs.mkdirSync(path.join(queueDir, "judging"), { recursive: true });
fs.mkdirSync(path.join(queueDir, "judged"), { recursive: true });
writeTask(queueDir, "judging", "j1.json", { rule: "測試", task: "skill-dispatch", enqueued_at: "2026-06-26T03:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "日常修改", event_id: "$3" }, judge: { status: "judging" } });
writeTask(queueDir, "judged", "j2.json", { rule: "測試", task: "skill-dispatch", enqueued_at: "2026-06-26T04:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "純聊天", event_id: "$4" }, judge: { status: "rejected", detail: null } });
{
  const withJudge = collectTasks(queueDir, rooms, 100);
  const j1 = withJudge.find((t) => t.id === "j1");
  const j2 = withJudge.find((t) => t.id === "j2");
  ok("judging 紀錄進任務清單", j1 && j1.status === "judging" && j1.judge.status === "judging");
  ok("judged 紀錄進任務清單且帶 judge 欄位", j2 && j2.status === "judged" && j2.judge.status === "rejected");
  ok("判斷紀錄照 enqueued_at 排最前", withJudge[0].id === "j2");
  const c2 = statusCounts(queueDir);
  ok("statusCounts 含 judging/judged", c2.judging === 1 && c2.judged === 1);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`aggregate.test.js: ${passed} 項通過 ✅`);
