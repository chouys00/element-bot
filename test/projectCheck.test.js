"use strict";
const assert = require("assert");
const { projectCheck } = require("../src/projectCheck");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

const directoryStat = { isDirectory: () => true };
const fileStat = { isDirectory: () => false };

{
  const r = projectCheck("", {});
  ok("空路徑 → 未指定", r.exists === false && r.detail.includes("未指定"));
}
{
  const r = projectCheck("D:/nope", { existsFn: () => false });
  ok("路徑不存在 → exists/directory false", r.exists === false && r.directory === false && r.detail.includes("不存在"));
}
{
  const r = projectCheck("D:/file", { existsFn: () => true, statFn: () => fileStat });
  ok("路徑存在但非目錄 → directory false", r.exists === true && r.directory === false && r.detail.includes("不是目錄"));
}
{
  const r = projectCheck("D:/dir", { existsFn: () => true, statFn: () => directoryStat });
  ok("路徑存在且是目錄 → 全 true", r.exists === true && r.directory === true && r.detail.includes("目錄"));
}
{
  const source = require("fs").readFileSync(require.resolve("../src/projectCheck"), "utf8");
  ok("projectCheck 不啟動 git", !/child_process|spawnSync|\bgit\b/i.test(source));
}

console.log(`projectCheck.test.js: ${passed} 項通過 ✅`);
