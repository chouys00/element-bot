"use strict";
const assert = require("assert");
const fs = require("fs");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const {
  buildCodexArgs,
  runCodex,
  runCodexSync,
} = require("../src/codexRunner");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }
async function rejects(name, fn, pattern) {
  let error;
  try { await fn(); } catch (e) { error = e; }
  ok(name, !!error && pattern.test(String(error.message || error)));
}

function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

(async () => {
  const judgeArgs = buildCodexArgs("judge");
  ok("judge 使用 codex exec", judgeArgs.includes("exec"));
  ok("judge 使用 read-only", judgeArgs.includes("read-only"));
  ok("judge 使用 ephemeral", judgeArgs.includes("--ephemeral"));
  ok("judge 從 stdin 讀 prompt", judgeArgs[judgeArgs.length - 1] === "-");

  const probeArgs = buildCodexArgs("probe");
  ok("probe 使用 read-only", probeArgs.includes("read-only"));

  const executeArgs = buildCodexArgs("execute");
  ok("execute 使用 workspace-write", executeArgs.includes("workspace-write"));
  ok("execute 明確開啟 workspace 網路", executeArgs.includes("sandbox_workspace_write.network_access=true"));
  ok("execute 不使用 danger-full-access", !executeArgs.includes("danger-full-access"));
  ok("execute 不略過 sandbox", !executeArgs.includes("--dangerously-bypass-approvals-and-sandbox"));

  assert.throws(() => buildCodexArgs("unknown"), /未知.*mode|mode.*unknown/i);
  passed++;

  let asyncCall;
  const output = await runCodex("請回覆 ok", {
    mode: "probe",
    cwd: "D:/tmp/project",
    spawnFn(command, args, options) {
      asyncCall = { command, args, options };
      const child = fakeChild({ stdout: "ok\n", stderr: "progress\n" });
      let input = "";
      child.stdin.on("data", (chunk) => { input += chunk; });
      child.stdin.on("finish", () => { asyncCall.input = input; });
      return child;
    },
  });
  ok("非同步 runner 回傳 stdout", output === "ok\n");
  ok("非同步 runner 使用 CODEX_COMMAND 預設值", asyncCall.command === "codex");
  ok("非同步 runner 傳入 cwd", asyncCall.options.cwd === "D:/tmp/project");
  ok("非同步 runner 以 stdin 傳 prompt", asyncCall.input === "請回覆 ok");

  await rejects(
    "非零 exit 會同時提供 stderr 與 stdout 診斷",
    () => runCodex("x", {
      mode: "judge",
      spawnFn: () => fakeChild({ code: 7, stdout: "last output", stderr: "bad auth" }),
    }),
    /Codex CLI exit 7.*bad auth.*last output/s
  );

  let schemaPath;
  let schemaOnDisk;
  const schema = {
    type: "object",
    properties: { trigger: { type: "boolean" } },
    required: ["trigger"],
    additionalProperties: false,
  };
  await runCodex("判斷", {
    mode: "judge",
    outputSchema: schema,
    spawnFn(command, args) {
      schemaPath = args[args.indexOf("--output-schema") + 1];
      schemaOnDisk = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      return fakeChild({ stdout: '{"trigger":true}' });
    },
  });
  ok("output schema 在啟動 Codex 前寫入暫存檔", schemaOnDisk.required[0] === "trigger");
  ok("output schema 參數有傳給 Codex", typeof schemaPath === "string" && schemaPath.length > 0);
  ok("Codex 結束後清除 output schema 暫存檔", !fs.existsSync(schemaPath));

  let syncCall;
  const syncOutput = runCodexSync("修改檔案", {
    mode: "execute",
    cwd: "D:/tmp/project",
    spawnSyncFn(command, args, options) {
      syncCall = { command, args, options };
      return { status: 0, stdout: "done", stderr: "progress" };
    },
  });
  ok("同步 runner 回傳 stdout", syncOutput === "done");
  ok("同步 runner 以 input 傳 prompt", syncCall.options.input === "修改檔案");
  ok("同步 runner 使用 execute args", syncCall.args.includes("workspace-write"));

  assert.throws(
    () => runCodexSync("x", {
      mode: "execute",
      spawnSyncFn: () => ({ status: 2, stdout: "partial", stderr: "failed" }),
    }),
    /Codex CLI exit 2.*failed.*partial/s
  );
  passed++;

  console.log(`codexRunner.test.js: ${passed} 項通過 ✅`);
})().catch((e) => { console.error(e); process.exit(1); });
