"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/dashboard/server");
const { loadDashboardConfig } = require("../src/config");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

(async () => {
  const originalMatrixUserId = process.env.MATRIX_USER_ID;
  process.env.MATRIX_USER_ID = "@configured_bot:ims.opscloud.info";
  const dashboardConfig = loadDashboardConfig();
  if (originalMatrixUserId === undefined) delete process.env.MATRIX_USER_ID;
  else process.env.MATRIX_USER_ID = originalMatrixUserId;
  ok("dashboard config 帶入 Matrix 帳號", dashboardConfig.matrixUserId === "@configured_bot:ims.opscloud.info");
  const dashboardIndexSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "index.js"), "utf8");
  ok("dashboard 啟動時把 Matrix 帳號傳給 server", dashboardIndexSource.includes("matrixUserId: config.matrixUserId"));

  const root = path.join(os.tmpdir(), `dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const queueDir = path.join(root, "queue");
  const storageDir = path.join(root, "storage");
  const outputFile = path.join(root, "output", "messages.jsonl");
  for (const s of ["pending", "done"]) fs.mkdirSync(path.join(queueDir, s), { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  fs.writeFileSync(path.join(storageDir, "rooms.json"), JSON.stringify({ "!r:s": "產品群" }), "utf8");
  fs.writeFileSync(path.join(storageDir, "bot-heartbeat"), String(Date.now()), "utf8");
  fs.writeFileSync(path.join(queueDir, "done", "t1.json"), JSON.stringify({ rule: "會議", task: "cal", enqueued_at: "2026-06-26T01:00:00.000Z", source: { room_id: "!r:s", sender: "@a", body: "hi", event_id: "$1" } }), "utf8");
  fs.appendFileSync(outputFile, JSON.stringify({ room_id: "!r:s", sender: "@a", body: "hello" }) + "\n", "utf8");

  const rulesPath = path.join(root, "rules.json");
  fs.writeFileSync(rulesPath, JSON.stringify([{ name: "改顏色", keywords: ["改顏色"], task: "skill-dispatch", project_path: root, target_branch: "main", command: "把背景改成紅色", use_llm: false }]), "utf8");

  // 假 judge:body 含「觸發」→ trigger true 並抽出固定連結,否則 trigger false。供 /api/rules/judge 測試,不打真 Codex。
  const fakeJudge = async (_rule, body) => ({ trigger: String(body).includes("觸發"), params: { 連結: "https://example.com/x" } });
  const server = createServer({
    queueDir, storageDir, outputFile, rulesPath,
    envRoomIds: ["!env:s"],
    matrixUserId: "@fe_bot:ims.opscloud.info",
    judgeFn: fakeJudge,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  ok("tasks 回一筆", tasks.length === 1);
  ok("狀態 done", tasks[0].status === "done");
  ok("房間名稱翻譯", tasks[0].room_name === "產品群");

  const status = await (await fetch(`${base}/api/status`)).json();
  ok("bot 線上", status.bot_online === true);
  ok("done 計數 1", status.counts.done === 1);
  ok("status 回傳 Matrix 帳號名稱", status.matrix_account_name === "fe_bot");

  const msgs = await (await fetch(`${base}/api/messages`)).json();
  ok("messages 一筆", msgs.length === 1 && msgs[0].body === "hello");
  ok("messages 房間名稱已翻譯", msgs[0].room_name === "產品群");

  const log = await (await fetch(`${base}/api/tasks/t1/log`)).json();
  ok("日誌占位", log.source === "none");

  const html = await fetch(`${base}/`);
  ok("根路徑回 200", html.status === 200);
  const htmlText = await html.text();
  ok("dashboard 支援 blocked 狀態", htmlText.includes('blocked: "受阻"'));
  ok("dashboard 保留 Codex 輸出欄", htmlText.includes("執行輸出 (Codex)"));
  ok("任務詳情顯示簡短任務編號",
    htmlText.includes('<span class="k">任務編號</span>') &&
    htmlText.includes("${esc(t.task_number || t.id)}"));
  ok("dashboard 不提供開啟專案按鈕或請求",
    !htmlText.includes("開啟專案") &&
    !htmlText.includes('data-act="open"') &&
    !htmlText.includes("/open"));
  ok("dashboard 提供驗收連結區塊", htmlText.includes("驗收連結") && !htmlText.includes("相關連結"));
  ok("dashboard 保存可信內網公司 ID", htmlText.includes("element-bot.approved-by") && htmlText.includes('id="approverDisplay"'));
  ok("dashboard 公司 ID 唯讀顯示且可更換",
    htmlText.includes('id="changeApprover"') &&
    !htmlText.includes('id="approverName"'));
  ok("dashboard 顯示 Matrix 帳號與操作者",
    htmlText.includes('id="matrixAccount"') &&
    htmlText.includes("操作者：") &&
    !htmlText.includes("驗收人："));
  ok("dashboard Header 使用三項摘要",
    htmlText.includes("執行中") &&
    htmlText.includes("待驗收") &&
    htmlText.includes("異常") &&
    !htmlText.includes("<span>LLM 判斷中"));
  ok("dashboard 首次驗收才提示公司 ID 與範例",
    htmlText.includes("請輸入公司 ID（例如 patrick.zyx）") &&
    htmlText.includes("^[A-Za-z]+\\.[A-Za-z]+$") &&
    htmlText.includes("prompt("));
  ok("dashboard 使用 approve API", htmlText.includes("/approve") && !htmlText.includes("/verify"));
  ok("dashboard 顯示發布狀態", htmlText.includes('publishing: "提交中"') && htmlText.includes('publish_failed: "發布失敗"'));
  ok("dashboard 區分已發布與結果未知", htmlText.includes('published: "已發布"') && htmlText.includes('publish_unknown: "發布結果未知"'));
  ok("dashboard 顯示發布診斷並只允許完整事件重試", htmlText.includes("last_error") && htmlText.includes("approval.attempt") && htmlText.includes("publish-retry") && htmlText.includes("!t.approval.malformed"));
  ok("dashboard 顯示已關閉狀態與關閉資訊",
    htmlText.includes('closed: "已關閉"') &&
    htmlText.includes("t.closure.closed_by") &&
    htmlText.includes("t.closure.closed_at"));
  ok("dashboard 提供關閉與重新開啟按鈕",
    htmlText.includes('data-act="close"') &&
    htmlText.includes("設為已關閉") &&
    htmlText.includes('data-act="reopen"') &&
    htmlText.includes("重新開啟"));
  ok("dashboard 關閉時沿用 localStorage 操作者",
    htmlText.includes("body: JSON.stringify({ closed_by: closedBy })") &&
    htmlText.includes("/${act}`"));
  ok("dashboard 不保留 legacy 顯示分支",
    !htmlText.includes("legacySumHtml") &&
    !htmlText.includes("const isGeneric") &&
    !htmlText.includes("修改／產出"));
  const fullHtmlSource = (htmlText.match(/const fullHtml = `([\s\S]*?)`;/) || [])[1] || "";
  ok("Codex output 在步驟前且只出現一次",
    fullHtmlSource.indexOf("${aiHtml}") >= 0 &&
    fullHtmlSource.indexOf("${aiHtml}") < fullHtmlSource.indexOf("${stepsHtml}") &&
    (fullHtmlSource.match(/aiHtml/g) || []).length === 1);

  const rulesHtmlText = await (await fetch(`${base}/rules.html`)).text();
  ok("規則頁可設定 target_branch", rulesHtmlText.includes('id="f_target_branch"'));
  ok("專案健檢 UI 只顯示路徑存在與是目錄",
    rulesHtmlText.includes("路徑存在") && rulesHtmlText.includes("是目錄") &&
    !/git 倉庫|未提交|乾淨/.test(rulesHtmlText));
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "server.js"), "utf8");
  ok("probe 只在路徑不存在或非目錄時 blocked",
    serverSource.includes("if (!chk.exists || !chk.directory)") && !serverSource.includes("!chk.is_git"));

  const traversal = await fetch(`${base}/api/tasks/..%2F..%2Fsecret/log`);
  ok("log 端點擋路徑穿越(400)", traversal.status === 400);

  // POST requeue:failed/<id>.json → pending/<id>.json
  fs.mkdirSync(path.join(queueDir, "failed"), { recursive: true });
  fs.writeFileSync(path.join(queueDir, "failed", "r1.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  fs.writeFileSync(path.join(queueDir, "failed", "r1.json.error.txt"), "boom", "utf8");
  const rq = await fetch(`${base}/api/tasks/r1/requeue`, { method: "POST" });
  ok("requeue 回 200", rq.status === 200);
  ok("已移回 pending/", fs.existsSync(path.join(queueDir, "pending", "r1.json")));

  fs.mkdirSync(path.join(queueDir, "blocked"), { recursive: true });
  fs.writeFileSync(path.join(queueDir, "blocked", "r2.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const blockedRequeue = await fetch(`${base}/api/tasks/r2/requeue`, { method: "POST" });
  ok("blocked 任務可重跑", blockedRequeue.status === 200 && fs.existsSync(path.join(queueDir, "pending", "r2.json")));
  ok("failed/ 任務已無", !fs.existsSync(path.join(queueDir, "failed", "r1.json")));
  ok("error.txt 已清", !fs.existsSync(path.join(queueDir, "failed", "r1.json.error.txt")));

  // POST close/reopen：獨立標記，不搬動原任務；只接受待驗收與異常。
  fs.writeFileSync(path.join(queueDir, "done", "close-review.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const closeReview = await fetch(`${base}/api/tasks/close-review/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ closed_by: "  patrick.zyx  ", closed_at: "2000-01-01" }),
  });
  ok("待驗收任務可設為已關閉", closeReview.status === 201);
  const closureFile = path.join(queueDir, "closed", "close-review.json");
  const closure = JSON.parse(fs.readFileSync(closureFile, "utf8"));
  ok("關閉標記保存公司 ID 並去除前後空白", closure.closed_by === "patrick.zyx");
  ok("關閉時間由 server 產生", closure.closed_at !== "2000-01-01" && Number.isFinite(Date.parse(closure.closed_at)));
  ok("關閉不搬動原任務", fs.existsSync(path.join(queueDir, "done", "close-review.json")));

  const closedTasks = await (await fetch(`${base}/api/tasks`)).json();
  ok("task API 帶關閉人員與時間",
    closedTasks.find((task) => task.id === "close-review").closure.closed_by === "patrick.zyx");
  const closedStatus = await (await fetch(`${base}/api/status`)).json();
  ok("關閉後不再累計待驗收", closedStatus.counts.review === 1 && closedStatus.counts.closed === 1);

  const duplicateClose = await fetch(`${base}/api/tasks/close-review/close`, {
    method: "POST",
    body: JSON.stringify({ closed_by: "jane.doe" }),
  });
  ok("重複關閉回既有標記", duplicateClose.status === 200);
  const closureAgain = JSON.parse(fs.readFileSync(closureFile, "utf8"));
  ok("重複關閉不覆寫人員或時間",
    closureAgain.closed_by === closure.closed_by && closureAgain.closed_at === closure.closed_at);

  const reopen = await fetch(`${base}/api/tasks/close-review/reopen`, { method: "POST" });
  ok("已關閉任務可重新開啟", reopen.status === 200 && !fs.existsSync(closureFile));
  const reopenedTasks = await (await fetch(`${base}/api/tasks`)).json();
  ok("重新開啟後恢復原狀態", !reopenedTasks.find((task) => task.id === "close-review").closure);
  const duplicateReopen = await fetch(`${base}/api/tasks/close-review/reopen`, { method: "POST" });
  ok("重複重新開啟保持成功", duplicateReopen.status === 200);

  fs.writeFileSync(path.join(queueDir, "failed", "close-failed.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const closeFailed = await fetch(`${base}/api/tasks/close-failed/close`, {
    method: "POST", body: JSON.stringify({ closed_by: "patrick.zyx" }),
  });
  ok("失敗任務可設為已關閉", closeFailed.status === 201);
  fs.writeFileSync(path.join(queueDir, "blocked", "close-blocked.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const closeBlocked = await fetch(`${base}/api/tasks/close-blocked/close`, {
    method: "POST", body: JSON.stringify({ closed_by: "patrick.zyx" }),
  });
  ok("受阻任務可設為已關閉", closeBlocked.status === 201);

  for (const statusName of ["failed", "unknown"]) {
    const id = `close-publish-${statusName}`;
    fs.writeFileSync(path.join(queueDir, "done", `${id}.json`), JSON.stringify({ rule: "x", task: "skill-dispatch" }), "utf8");
    fs.mkdirSync(path.join(queueDir, "approvals", statusName), { recursive: true });
    fs.writeFileSync(path.join(queueDir, "approvals", statusName, `${id}.json`), JSON.stringify({
      task_id: id, approved_by: "patrick.zyx", approved_at: "2026-07-22T01:00:00.000Z",
    }), "utf8");
    const response = await fetch(`${base}/api/tasks/${id}/close`, {
      method: "POST", body: JSON.stringify({ closed_by: "patrick.zyx" }),
    });
    ok(`發布${statusName === "failed" ? "失敗" : "結果未知"}任務可設為已關閉`, response.status === 201);
  }

  fs.writeFileSync(path.join(queueDir, "pending", "cannot-close.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const closePending = await fetch(`${base}/api/tasks/cannot-close/close`, {
    method: "POST", body: JSON.stringify({ closed_by: "patrick.zyx" }),
  });
  ok("進行中的任務不可關閉", closePending.status === 409);
  fs.writeFileSync(path.join(queueDir, "failed", "bad-closer.json"), JSON.stringify({ rule: "x", task: "t" }), "utf8");
  const invalidCloser = await fetch(`${base}/api/tasks/bad-closer/close`, {
    method: "POST", body: JSON.stringify({ closed_by: "patrick" }),
  });
  ok("關閉操作者格式錯誤會被拒絕", invalidCloser.status === 400 && (await invalidCloser.text()).includes("公司 ID"));
  const closeUnknown = await fetch(`${base}/api/tasks/ghost/close`, {
    method: "POST", body: JSON.stringify({ closed_by: "patrick.zyx" }),
  });
  ok("關閉不存在任務回 404", closeUnknown.status === 404);
  const reopenUnknown = await fetch(`${base}/api/tasks/ghost/reopen`, { method: "POST" });
  ok("重新開啟不存在任務回 404", reopenUnknown.status === 404);

  // POST approve:只接受驗收人，其他欄位一律取既有 done task 與 server 時間。
  fs.writeFileSync(path.join(queueDir, "done", "v1.json"), JSON.stringify({
    rule: "x", task: "skill-dispatch", project_path: root, target_branch: "main",
  }), "utf8");
  const v1Workspace = path.join(queueDir, "work", "v1", "workspace");
  fs.mkdirSync(v1Workspace, { recursive: true });
  const approved = await fetch(`${base}/api/tasks/v1/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved_by: "  patrick.zyx  ", target_branch: "evil", approved_at: "2000-01-01" }),
  });
  ok("首次 approve 回 201", approved.status === 201);
  const approvalFile = path.join(queueDir, "approvals", "pending", "v1.json");
  const approval = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
  ok("approval 保存公司 ID 並去除前後空白", approval.approved_by === "patrick.zyx");
  ok("approval 分支取自任務而非 request", approval.target_branch === "main");
  ok("approval 帶完整 task_id 與專案路徑", approval.task_id === "v1" && approval.project_path === root);
  ok("approval 綁定 Task 專屬 worktree", approval.workspace_path === v1Workspace);
  ok("approval 時間由 server 產生", approval.approved_at !== "2000-01-01" && Number.isFinite(Date.parse(approval.approved_at)));

  const duplicate = await fetch(`${base}/api/tasks/v1/approve`, {
    method: "POST",
    body: JSON.stringify({ approved_by: "jane.doe" }),
  });
  ok("重複 approve 回既有事件", duplicate.status === 200);
  const approvalAgain = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
  ok("重複 approve 不覆寫人員或時間", approvalAgain.approved_by === approval.approved_by && approvalAgain.approved_at === approval.approved_at);

  for (const invalidId of ["", "patrick", "patrick.zyx.extra", "patrick.123", "王小明"]) {
    const invalidApproval = await fetch(`${base}/api/tasks/v1/approve`, {
      method: "POST",
      body: JSON.stringify({ approved_by: invalidId }),
    });
    ok(`公司 ID 格式錯誤會被拒絕：${invalidId || "空值"}`, invalidApproval.status === 400);
    ok("公司 ID 格式錯誤有明確提示", (await invalidApproval.text()).includes("公司 ID"));
  }

  const approveUnknown = await fetch(`${base}/api/tasks/ghost/approve`, { method: "POST", body: JSON.stringify({ approved_by: "patrick.zyx" }) });
  ok("approve 無此任務 → 404", approveUnknown.status === 404);
  fs.writeFileSync(path.join(queueDir, "pending", "p1.json"), JSON.stringify({ task: "skill-dispatch", project_path: root, target_branch: "main" }), "utf8");
  const approvePending = await fetch(`${base}/api/tasks/p1/approve`, { method: "POST", body: JSON.stringify({ approved_by: "patrick.zyx" }) });
  ok("非 done 任務不能 approve", approvePending.status === 409);
  fs.writeFileSync(path.join(queueDir, "done", "n1.json"), JSON.stringify({ task: "other", project_path: root, target_branch: "main" }), "utf8");
  const approveOther = await fetch(`${base}/api/tasks/n1/approve`, { method: "POST", body: JSON.stringify({ approved_by: "patrick.zyx" }) });
  ok("非 skill-dispatch 不能 approve", approveOther.status === 400);
  fs.writeFileSync(path.join(queueDir, "done", "m1.json"), JSON.stringify({ task: "skill-dispatch", project_path: root }), "utf8");
  const approveMissingBranch = await fetch(`${base}/api/tasks/m1/approve`, { method: "POST", body: JSON.stringify({ approved_by: "patrick.zyx" }) });
  ok("缺 target_branch 不能 approve", approveMissingBranch.status === 400);
  const approveNoName = await fetch(`${base}/api/tasks/v1/approve`, { method: "POST", body: JSON.stringify({ approved_by: "" }) });
  ok("空驗收人不能 approve", approveNoName.status === 400);

  fs.mkdirSync(path.join(queueDir, "approvals", "failed"), { recursive: true });
  const failedApproval = { ...approval, attempt: 3, last_error: "push 被拒絕", failed_at: "2026-07-21T03:00:00.000Z" };
  fs.writeFileSync(approvalFile, JSON.stringify(failedApproval), "utf8");
  fs.renameSync(approvalFile, path.join(queueDir, "approvals", "failed", "v1.json"));
  const retryPublish = await fetch(`${base}/api/tasks/v1/publish-retry`, { method: "POST" });
  ok("發布失敗可由 Dashboard 重試", retryPublish.status === 200 && fs.existsSync(approvalFile));
  const retriedApproval = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
  ok("重試發布保留原驗收身分與時間", retriedApproval.approved_by === approval.approved_by && retriedApproval.approved_at === approval.approved_at);
  ok("重試發布重設執行次數但保留重試記錄", retriedApproval.attempt === 0 && retriedApproval.retry_count === 1);

  fs.writeFileSync(path.join(queueDir, "done", "malformed-publish.json"), JSON.stringify({ task: "skill-dispatch", project_path: root, target_branch: "main" }), "utf8");
  fs.writeFileSync(path.join(queueDir, "approvals", "failed", "malformed-publish.json"), JSON.stringify({ task_id: "malformed-publish", malformed: true, last_error: "bad", attempt: 0 }), "utf8");
  const retryMalformed = await fetch(`${base}/api/tasks/malformed-publish/publish-retry`, { method: "POST" });
  ok("損毀 approval 不可從 Dashboard 重試", retryMalformed.status === 409);

  const legacyVerify = await fetch(`${base}/api/tasks/v1/verify`, { method: "POST" });
  ok("舊 verify API 已移除", legacyVerify.status === 404 && !fs.existsSync(path.join(queueDir, "work", "v1", "verified.json")));

  // 公共電腦不提供遠端開啟專案 API。
  fs.mkdirSync(path.join(queueDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(queueDir, "logs", "o1.log"), JSON.stringify({ status: "OK", summary: "x", openPath: "C:/evil/x" }) + "\n", "utf8");
  const op = await fetch(`${base}/api/tasks/o1/open`, { method: "POST" });
  ok("open API 已移除 → 404", op.status === 404);

  // POST 防穿越:id 帶 .. → 400
  const badPost = await fetch(`${base}/api/tasks/..%2Fx/requeue`, { method: "POST" });
  ok("穿越 POST id 擋下", badPost.status === 400);

  // requeue 不存在的 failed 任務 → 404
  const noFail = await fetch(`${base}/api/tasks/nope/requeue`, { method: "POST" });
  ok("requeue 無此 failed → 404", noFail.status === 404);

  // GET /api/rules → { rules, rooms, tasks }
  const rd = await (await fetch(`${base}/api/rules`)).json();
  ok("rules GET 回現有規則", Array.isArray(rd.rules) && rd.rules.length === 1 && rd.rules[0].name === "改顏色");
  ok("rules GET 附房間 id→名", rd.rooms["!r:s"] === "產品群");
  ok("rules GET 附 task 名單", Array.isArray(rd.tasks) && rd.tasks.length === 1 && rd.tasks[0] === "skill-dispatch");
  ok("rules GET 附監聽清單(檔缺 → env 後備)", Array.isArray(rd.monitor_rooms) && rd.monitor_rooms[0] === "!env:s");

  fs.writeFileSync(rulesPath, JSON.stringify([{ name: "舊規則", keywords: ["x"], task: "skill-dispatch", project_path: root, command: "x", use_llm: false, rooms: ["!r:s"] }]), "utf8");
  const legacyRules = await (await fetch(`${base}/api/rules`)).json();
  ok("rules GET 明示舊規則缺分支設定錯誤", /target_branch/.test(legacyRules.configuration_errors[0]));
  ok("規則頁顯示配置錯誤", rulesHtmlText.includes("configuration_errors") && rulesHtmlText.includes("設定錯誤"));

  // PUT /api/rules 合法 → 寫入並可讀回
  const put = await fetch(`${base}/api/rules`, {
    method: "PUT",
    body: JSON.stringify([{ name: "新規則", keywords: ["x"], task: "skill-dispatch", project_path: root, target_branch: "main", command: "x", use_llm: false, rooms: ["!r:s"] }]),
  });
  ok("rules PUT 合法回 200", put.status === 200);
  const after = await (await fetch(`${base}/api/rules`)).json();
  ok("rules PUT 已落地", after.rules.length === 1 && after.rules[0].name === "新規則");
  ok("rules PUT 保留 rooms", after.rules[0].rooms[0] === "!r:s");

  // PUT 非法規則 → 400,且原檔不被覆寫
  const badPut = await fetch(`${base}/api/rules`, { method: "PUT", body: JSON.stringify([{ name: "" }]) });
  ok("rules PUT 非法回 400", badPut.status === 400);
  const stillThere = await (await fetch(`${base}/api/rules`)).json();
  ok("rules PUT 非法不覆寫原檔", stillThere.rules.length === 1 && stillThere.rules[0].name === "新規則");

  // PUT 壞 JSON → 400
  const badJson = await fetch(`${base}/api/rules`, { method: "PUT", body: "{not json" });
  ok("rules PUT 壞 JSON 回 400", badJson.status === 400);

  // POST /api/rules/dry-run:回報每條規則是否命中(此時檔案內容為前面 PUT 的「新規則」keywords:["x"], rooms:["!r:s"])
  const dry1 = await (await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: JSON.stringify({ body: "含有 x 的訊息", room_id: "!r:s" }) })).json();
  ok("dry-run 回 results 陣列", Array.isArray(dry1.results) && dry1.results.length === 1);
  ok("dry-run 命中且房間相符 → triggers", dry1.results[0].keyword_hit === true && dry1.results[0].triggers === true);

  const dry2 = await (await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: JSON.stringify({ body: "含有 x 的訊息", room_id: "!other:s" }) })).json();
  ok("dry-run 房間不符 → 不觸發", dry2.results[0].room_ok === false && dry2.results[0].triggers === false);

  const dry3 = await (await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: JSON.stringify({ body: "完全不相關" }) })).json();
  ok("dry-run 關鍵字未命中 → 不觸發", dry3.results[0].keyword_hit === false && dry3.results[0].triggers === false);

  const dryBad = await fetch(`${base}/api/rules/dry-run`, { method: "POST", body: "{not json" });
  ok("dry-run 壞 JSON 回 400", dryBad.status === 400);

  // POST /api/rules/judge:只跑 LLM 二次判斷(注入假 judge),回傳 trigger + 抽取 params。dry-run 之後前端逐條背景呼叫用。
  await fetch(`${base}/api/rules`, {
    method: "PUT",
    body: JSON.stringify([
      { name: "LLM規則", keywords: ["x"], task: "skill-dispatch", project_path: root, target_branch: "main", command: "{連結}", use_llm: true, intent: "測試意圖", extract: ["連結"], rooms: ["!r:s"] },
      { name: "非LLM規則", keywords: ["y"], task: "skill-dispatch", project_path: root, target_branch: "main", command: "y", use_llm: false, rooms: ["!r:s"] },
    ]),
  });
  const jTrig = await (await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 0, body: "請觸發這則" }) })).json();
  ok("judge use_llm 規則 → trigger true", jTrig.trigger === true);
  ok("judge 回抽取參數", jTrig.params && jTrig.params["連結"] === "https://example.com/x");

  const jNo = await (await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 0, body: "普通訊息" }) })).json();
  ok("judge 不含觸發字 → trigger false", jNo.trigger === false);

  const jSkip = await (await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 1, body: "y" }) })).json();
  ok("judge 非 use_llm 規則 → skipped", jSkip.skipped === true);

  const jNF = await fetch(`${base}/api/rules/judge`, { method: "POST", body: JSON.stringify({ index: 99, body: "x" }) });
  ok("judge 無此規則 → 404", jNF.status === 404);

  const jBad = await fetch(`${base}/api/rules/judge`, { method: "POST", body: "{not json" });
  ok("judge 壞 JSON → 400", jBad.status === 400);

  // GET /api/notify-config → 預設(停用)+ 房間清單
  const nc0 = await (await fetch(`${base}/api/notify-config`)).json();
  ok("notify-config GET 預設停用", nc0.config.enabled === false);
  ok("notify-config GET 附房間 id→名", nc0.rooms["!r:s"] === "產品群");

  // PUT 合法 → 落地並可讀回
  const ncPut = await fetch(`${base}/api/notify-config`, { method: "PUT", body: JSON.stringify({ enabled: true, room_id: "!r:s", notify_on: "all" }) });
  ok("notify-config PUT 合法回 200", ncPut.status === 200);
  const nc1 = await (await fetch(`${base}/api/notify-config`)).json();
  ok("notify-config PUT 已落地", nc1.config.enabled === true && nc1.config.room_id === "!r:s");

  // PUT 非法(啟用卻沒房間)→ 400,且不覆寫原檔
  const ncBad = await fetch(`${base}/api/notify-config`, { method: "PUT", body: JSON.stringify({ enabled: true, room_id: "" }) });
  ok("notify-config PUT 非法回 400", ncBad.status === 400);
  const nc2 = await (await fetch(`${base}/api/notify-config`)).json();
  ok("notify-config PUT 非法不覆寫", nc2.config.room_id === "!r:s");

  // PUT 壞 JSON → 400
  const ncJson = await fetch(`${base}/api/notify-config`, { method: "PUT", body: "{not json" });
  ok("notify-config PUT 壞 JSON 回 400", ncJson.status === 400);

  // GET /api/rooms-config → 檔缺回 env 後備 + 房間名映射
  const rc0 = await (await fetch(`${base}/api/rooms-config`)).json();
  ok("rooms-config GET 檔缺回 env 後備", Array.isArray(rc0.room_ids) && rc0.room_ids[0] === "!env:s");
  ok("rooms-config GET 附房間 id→名", rc0.rooms["!r:s"] === "產品群");

  // PUT 合法 → 落地(正規化去重),之後 GET 用檔而非 env,且 /api/rules monitor_rooms 同步
  const rcPut = await fetch(`${base}/api/rooms-config`, { method: "PUT", body: JSON.stringify({ room_ids: [" !r:s ", "!x:s", "!r:s"] }) });
  ok("rooms-config PUT 合法回 200", rcPut.status === 200);
  const rc1 = await (await fetch(`${base}/api/rooms-config`)).json();
  ok("rooms-config PUT 已落地並去重/trim", rc1.room_ids.length === 2 && rc1.room_ids[0] === "!r:s" && rc1.room_ids[1] === "!x:s");
  const rulesAfterRc = await (await fetch(`${base}/api/rules`)).json();
  ok("rules monitor_rooms 反映存檔後清單", rulesAfterRc.monitor_rooms.length === 2 && rulesAfterRc.monitor_rooms[1] === "!x:s");

  // PUT 非法(room_ids 非陣列)→ 400,且不覆寫原檔
  const rcBad = await fetch(`${base}/api/rooms-config`, { method: "PUT", body: JSON.stringify({ room_ids: "nope" }) });
  ok("rooms-config PUT 非法回 400", rcBad.status === 400);
  const rc2 = await (await fetch(`${base}/api/rooms-config`)).json();
  ok("rooms-config PUT 非法不覆寫", rc2.room_ids.length === 2 && rc2.room_ids[0] === "!r:s");

  // PUT 壞 JSON → 400
  const rcJson = await fetch(`${base}/api/rooms-config`, { method: "PUT", body: "{not json" });
  ok("rooms-config PUT 壞 JSON 回 400", rcJson.status === 400);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`dashboardServer.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
