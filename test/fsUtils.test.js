"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDir, readJsonSafe, writeJsonAtomic } = require("../src/fsUtils");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

const base = path.join(os.tmpdir(), `fsu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

// ensureDir
const nested = path.join(base, "a", "b", "c");
ok("ensureDir 回傳傳入路徑", ensureDir(nested) === nested);
ok("ensureDir 遞迴建立", fs.existsSync(nested));
ok("ensureDir 已存在不丟錯", ensureDir(nested) === nested);

// readJsonSafe
const jf = path.join(base, "data.json");
ok("缺檔回 fallback(預設 null)", readJsonSafe(jf) === null);
ok("缺檔回自訂 fallback", JSON.stringify(readJsonSafe(jf, {})) === "{}");
fs.writeFileSync(jf, JSON.stringify({ x: 1 }), "utf8");
ok("正常讀回 JSON", readJsonSafe(jf).x === 1);
fs.writeFileSync(jf, "{壞掉", "utf8");
ok("壞 JSON 回 fallback", readJsonSafe(jf, "bad") === "bad");

// writeJsonAtomic
const wf = path.join(base, "sub", "out.json");
const data = { a: [1, 2], b: "字" };
ok("writeJsonAtomic 回傳資料本身", writeJsonAtomic(wf, data) === data);
ok("自動建立父目錄並寫入", readJsonSafe(wf).b === "字");
ok("無殘留 .tmp 檔", !fs.existsSync(wf + ".tmp"));
ok("縮排 2 空白(與既有檔案格式一致)", fs.readFileSync(wf, "utf8").includes('  "a"'));
writeJsonAtomic(wf, { a: 9 });
ok("覆寫既有檔", readJsonSafe(wf).a === 9);

fs.rmSync(base, { recursive: true, force: true });

console.log(`fsUtils.test.js: ${passed} 項通過 ✅`);
