"use strict";
const assert = require("assert");
const { projectCheck } = require("../src/projectCheck");

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; }

// 假注入:existsFn 控制路徑存在與否;runGit 模擬 git status --porcelain 結果。
const gitClean = () => ({ status: 0, stdout: "" });
const gitDirty = () => ({ status: 0, stdout: " M a.js\n" });
const gitFail = () => ({ status: 128, stdout: "", stderr: "not a git repo" });

{
  const r = projectCheck("", {});
  ok("空路徑 → 未指定", r.exists === false && r.detail.includes("未指定"));
}
{
  const r = projectCheck("D:/nope", { existsFn: () => false });
  ok("路徑不存在 → exists false", r.exists === false && r.detail.includes("不存在"));
}
{
  const r = projectCheck("D:/x", { existsFn: () => true, runGit: gitFail });
  ok("存在但非 git → is_git false", r.exists === true && r.is_git === false && r.clean === false);
}
{
  const r = projectCheck("D:/x", { existsFn: () => true, runGit: gitDirty });
  ok("git 有改動 → clean false", r.exists === true && r.is_git === true && r.clean === false && r.detail.includes("未提交"));
}
{
  const r = projectCheck("D:/x", { existsFn: () => true, runGit: gitClean });
  ok("git 乾淨 → 全 true", r.exists === true && r.is_git === true && r.clean === true);
}

console.log(`projectCheck.test.js: ${passed} 項通過 ✅`);
