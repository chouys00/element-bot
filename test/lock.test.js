"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { acquireLock, lockPath, isOurBotProcess, looksLikeOurBot, getCommandLine } = require("../src/lock");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

// 全程只用臨時目錄當 storageDir,絕不可碰真正的 storage/bot.lock——
// 那個檔案可能正被真的在跑的 bot 持有,測試誤刪會讓兩個實例同時啟動、毀掉裝置金鑰。
const base = path.join(os.tmpdir(), `lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// --- looksLikeOurBot:純函式,不碰檔案/程序 ---
ok("含 index.js 視為我們的 bot", looksLikeOurBot("node src/index.js") === true);
ok("含完整路徑的 index.js 也算", looksLikeOurBot('"C:\\nodejs\\node.exe" src\\index.js') === true);
ok("不含 index.js 視為別的程式", looksLikeOurBot("msedgewebview2.exe --embedded-browser-webview=1") === false);
ok("非字串(null)視為別的程式", looksLikeOurBot(null) === false);
ok("空字串視為別的程式", looksLikeOurBot("") === false);

// --- lockPath ---
ok("lockPath 組出 storageDir/bot.lock", lockPath(base) === path.join(base, "bot.lock"));

// --- getCommandLine:對真實 PID 的煙霧測試 ---
ok("查自己的 PID 拿得到非空命令列", typeof getCommandLine(process.pid) === "string" && getCommandLine(process.pid).length > 0);
ok("查一個不存在的 PID 回 null", getCommandLine(999999) === null);

// --- isOurBotProcess:對自己這個測試程序(命令列是 test/lock.test.js,不含 index.js)---
ok("測試程序自身不會被誤判成 bot", isOurBotProcess(process.pid) === false);

// --- acquireLock:過期鎖(PID 不存在)可正常取得,不丟錯 ---
{
  const dir = path.join(base, "stale-dead-pid");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPath(dir), "999999", "utf8");
  acquireLock(dir); // 不應丟錯
  ok("死 PID 的過期鎖被清掉並重新取得", fs.readFileSync(lockPath(dir), "utf8").trim() === String(process.pid));
}

// --- acquireLock:PID 存活但不是我們的 bot(被回收給別的程式)→ 視為過期鎖,不丟錯 ---
// 用一個真的存活、但命令列不含 index.js 的子程序模擬「PID 被回收給無關程式」。
async function testDecoyProcess() {
  const decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const dir = path.join(base, "decoy-not-us");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath(dir), String(decoy.pid), "utf8");
    acquireLock(dir); // 不應丟錯:decoy 存活但命令列不含 index.js
    ok("存活但非我們 bot 的 PID 不會擋住啟動", fs.readFileSync(lockPath(dir), "utf8").trim() === String(process.pid));
  } finally {
    decoy.kill();
  }
}

// --- acquireLock:PID 存活且命令列含 index.js → 視為真的衝突,丟錯 ---
// 用子程序把 "index.js" 當純字串參數(非真的執行檔案),命令列因此含 index.js,模擬真的 bot 實例。
async function testRealConflict() {
  const real = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)", "index.js"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const dir = path.join(base, "real-conflict");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath(dir), String(real.pid), "utf8");
    let threw = false;
    try {
      acquireLock(dir);
    } catch (e) {
      threw = /偵測到另一個 element-bot 實例/.test(e.message);
    }
    ok("存活且看起來是我們 bot 的 PID 會擋住啟動", threw);
  } finally {
    real.kill();
  }
}

(async () => {
  await testDecoyProcess();
  await testRealConflict();
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`lock.test.js: ${passed} 項通過 ✅`);
})();
