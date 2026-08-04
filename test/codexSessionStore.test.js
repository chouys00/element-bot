"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  SESSION_FILE,
  readCodexSession,
  writeCodexSession,
} = require("../src/codexSessionStore");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-store-"));
const session = {
  task_id: "task-1",
  session_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  created_at: "2026-08-04T00:00:00.000Z",
};

try {
  const saved = writeCodexSession(root, session);
  assert.deepStrictEqual(saved, session);
  assert.strictEqual(SESSION_FILE, "codex-session.json");
  assert.deepStrictEqual(readCodexSession(root, "task-1"), session);
  assert.ok(fs.existsSync(path.join(root, SESSION_FILE)));

  assert.throws(
    () => writeCodexSession(root, { ...session, session_id: "last" }),
    /session_id 不合法/,
  );
  assert.throws(
    () => readCodexSession(root, "other-task"),
    /task_id.*不符/,
  );
  assert.strictEqual(readCodexSession(path.join(root, "missing"), "task-1"), null);

  const cleanupState = {
    ...session,
    delete_attempted_at: "2026-08-12T00:00:00.000Z",
    delete_error: "Codex session 暫時被占用",
    delete_warning: "內容已刪除，但 Codex 索引仍殘留",
  };
  assert.deepStrictEqual(
    readCodexSession(root, "task-1"),
    session,
    "寫入清理狀態前仍保留原始 metadata",
  );
  writeCodexSession(root, cleanupState);
  assert.deepStrictEqual(readCodexSession(root, "task-1"), cleanupState);

  const replacement = {
    ...session,
    session_id: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    created_at: "2026-08-05T00:00:00.000Z",
  };
  const replaced = writeCodexSession(root, replacement);
  assert.deepStrictEqual(replaced.superseded_sessions, [{
    session_id: session.session_id,
    created_at: session.created_at,
  }], "重新執行不得遺失舊 session ID");

  const deleted = {
    ...replaced,
    deleted_at: "2026-08-13T00:00:00.000Z",
    deleted_session_ids: [session.session_id, replacement.session_id],
  };
  writeCodexSession(root, deleted);
  assert.deepStrictEqual(readCodexSession(root, "task-1"), {
    ...deleted,
    superseded_sessions: replaced.superseded_sessions,
  });

  console.log("codexSessionStore.test.js: Codex session metadata 驗證與保存通過 ✅");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
