"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  captureLocalUserName,
  restoreLocalUserName,
  setLocalUserName,
} = require("../src/approvalGitIdentity");

function git(repo, args, expectedStatus = 0) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.strictEqual(
    result.status,
    expectedStatus,
    result.stderr || `git ${args.join(" ")} 應回傳 ${expectedStatus}`,
  );
  return String(result.stdout || "").trim();
}

function initRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  return repo;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-git-identity-"));
  try {
    {
      const repo = initRepo(root, "with-local-name");
      git(repo, ["config", "--local", "user.name", "  原本名稱  "]);
      git(repo, ["config", "--local", "user.email", "original@example.invalid"]);

      const snapshot = await captureLocalUserName(repo);
      assert.deepStrictEqual(snapshot, { present: true, value: "  原本名稱  " });

      await setLocalUserName(repo, "patrick.zyx");
      assert.strictEqual(git(repo, ["config", "--local", "--get", "user.name"]), "patrick.zyx");
      assert.strictEqual(
        git(repo, ["config", "--local", "--get", "user.email"]),
        "original@example.invalid",
        "切換名稱不得修改 user.email",
      );

      await restoreLocalUserName(repo, snapshot);
      assert.strictEqual(git(repo, ["config", "--local", "--get", "user.name"]), "原本名稱");
      const restored = await captureLocalUserName(repo);
      assert.deepStrictEqual(restored, { present: true, value: "  原本名稱  " }, "還原時不得改動原值前後空白");
    }

    {
      const repo = initRepo(root, "without-local-name");
      const snapshot = await captureLocalUserName(repo);
      assert.deepStrictEqual(snapshot, { present: false, value: null });

      await setLocalUserName(repo, "jane.doe");
      assert.strictEqual(git(repo, ["config", "--local", "--get", "user.name"]), "jane.doe");

      await restoreLocalUserName(repo, snapshot);
      git(repo, ["config", "--local", "--get", "user.name"], 1);
    }

    await assert.rejects(
      () => captureLocalUserName(path.join(root, "not-a-repository")),
      /Git local user\.name 讀取失敗/,
    );

    console.log("approvalGitIdentity.test.js: 驗收 Git 名稱暫時切換與還原通過 ✅");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
