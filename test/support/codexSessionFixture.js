"use strict";
const path = require("path");
const { writeCodexSession } = require("../../src/codexSessionStore");

const DEFAULT_SESSION_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";

function writeTaskSession(queueDir, taskId, sessionId = DEFAULT_SESSION_ID, createdAt = "2026-07-21T00:00:00.000Z") {
  return writeCodexSession(path.join(queueDir, "work", taskId), {
    task_id: taskId,
    session_id: sessionId,
    created_at: createdAt,
  });
}

module.exports = { DEFAULT_SESSION_ID, writeTaskSession };
