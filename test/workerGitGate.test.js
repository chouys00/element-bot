"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { processOne, pollOnce } = require("../src/workerCore");
const { parseProgress } = require("../src/dashboard/aggregate");

const silentLogger = { log() {}, error() {} };

function freshQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "element-bot-worker-gate-"));
  fs.mkdirSync(path.join(dir, "pending"), { recursive: true });
  return dir;
}

function task(projectPath = "D:\\GB\\app") {
  return {
    task: "skill-dispatch",
    project_path: projectPath,
    target_branch: "main",
    command: "修改檔案",
  };
}

function writePending(queueDir, id, value = task()) {
  const file = path.join(queueDir, "pending", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

(async () => {
  {
    const queueDir = freshQueue();
    try {
      writePending(queueDir, "b");
      writePending(queueDir, "a");
      const seen = [];
      const count = await pollOnce({
        queueDir,
        logger: silentLogger,
        preflight: async () => ({ status: "ready" }),
        executor: async (_task, context) => {
          seen.push(context.id);
          return { queueStatus: "done" };
        },
      });
      assert.strictEqual(count, 1);
      assert.deepStrictEqual(seen, ["a"]);
      assert.ok(fs.existsSync(path.join(queueDir, "done", "a.json")));
      assert.ok(fs.existsSync(path.join(queueDir, "pending", "b.json")));
    } finally {
      fs.rmSync(queueDir, { recursive: true, force: true });
    }
  }

  {
    const queueDir = freshQueue();
    try {
      writePending(queueDir, "a");
      writePending(queueDir, "b");
      let executions = 0;
      const count = await pollOnce({
        queueDir,
        logger: silentLogger,
        preflight: async () => ({ status: "waiting", reason: "project_path 有未提交變更", branch: "main" }),
        executor: async () => {
          executions++;
          return { queueStatus: "done" };
        },
      });
      assert.strictEqual(count, 0);
      assert.strictEqual(executions, 0);
      assert.ok(fs.existsSync(path.join(queueDir, "pending", "a.json")));
      assert.ok(fs.existsSync(path.join(queueDir, "pending", "b.json")));
      assert.ok(!fs.existsSync(path.join(queueDir, "work", "a", "state.json")));
      assert.match(parseProgress(queueDir, "a").summary.output, /未提交變更/);
    } finally {
      fs.rmSync(queueDir, { recursive: true, force: true });
    }
  }

  {
    const queueDir = freshQueue();
    try {
      writePending(queueDir, "a", task("D:\\GB\\waiting-project"));
      writePending(queueDir, "b", task("D:\\GB\\ready-project"));
      const seen = [];
      const count = await pollOnce({
        queueDir,
        logger: silentLogger,
        preflight: async (pendingTask) => pendingTask.project_path.includes("waiting-project")
          ? { status: "waiting", reason: "同一專案的驗收推送尚未結案" }
          : { status: "ready" },
        executor: async (_task, context) => {
          seen.push(context.id);
          return { queueStatus: "done" };
        },
      });
      assert.strictEqual(count, 1);
      assert.deepStrictEqual(seen, ["b"], "前一筆等待時仍應處理其他可執行專案");
      assert.ok(fs.existsSync(path.join(queueDir, "pending", "a.json")));
      assert.ok(fs.existsSync(path.join(queueDir, "done", "b.json")));
    } finally {
      fs.rmSync(queueDir, { recursive: true, force: true });
    }
  }

  {
    const queueDir = freshQueue();
    try {
      writePending(queueDir, "a", task(path.join(queueDir, "missing")));
      writePending(queueDir, "b");
      const notifications = [];
      const count = await pollOnce({
        queueDir,
        logger: silentLogger,
        preflight: async () => ({ status: "blocked", reason: "project_path 不存在" }),
        executor: async () => { throw new Error("不應執行 Codex"); },
        notify: async (info) => notifications.push(info),
      });
      assert.strictEqual(count, 1);
      assert.ok(fs.existsSync(path.join(queueDir, "blocked", "a.json")));
      assert.ok(fs.existsSync(path.join(queueDir, "pending", "b.json")));
      assert.strictEqual(notifications.length, 1);
      assert.strictEqual(notifications[0].status, "blocked");
      assert.match(notifications[0].result.output, /project_path 不存在/);
      assert.match(parseProgress(queueDir, "a").summary.output, /project_path 不存在/);
    } finally {
      fs.rmSync(queueDir, { recursive: true, force: true });
    }
  }

  {
    const queueDir = freshQueue();
    try {
      const file = writePending(queueDir, "resume");
      const workDir = path.join(queueDir, "work", "resume");
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(workDir, "state.json"), JSON.stringify({
        id: "resume",
        attempt: 1,
        steps: { prepare: "ok", ai_run: "error", verify: "pending", summarize: "pending" },
      }), "utf8");
      let preflights = 0;
      let executions = 0;
      const status = await processOne(file, {
        queueDir,
        logger: silentLogger,
        preflight: async () => {
          preflights++;
          return { status: "waiting", reason: "dirty" };
        },
        executor: async () => {
          executions++;
          return { queueStatus: "done" };
        },
      });
      assert.strictEqual(status, "done");
      assert.strictEqual(preflights, 0);
      assert.strictEqual(executions, 1);
    } finally {
      fs.rmSync(queueDir, { recursive: true, force: true });
    }
  }

  console.log("workerGitGate.test.js: 單筆排程、Git 閘門與 checkpoint 續跑通過 ✅");
})().catch((error) => { console.error(error); process.exit(1); });
