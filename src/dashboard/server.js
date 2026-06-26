"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectTasks, statusCounts, resolveTaskLog, readMessagesTail } = require("./aggregate");
const { readRoomsMap } = require("../roomsSidecar");
const { readHeartbeat, isFresh } = require("../heartbeat");

const PUBLIC_DIR = path.join(__dirname, "public");
const HEARTBEAT_MAX_AGE_MS = 60000;
const TASKS_LIMIT = 100;
const MESSAGES_LIMIT = 50;

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// deps = { queueDir, storageDir, outputFile }
function createServer(deps) {
  const { queueDir, storageDir, outputFile } = deps;
  return http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    try {
      if (p === "/api/tasks") {
        return sendJson(res, 200, collectTasks(queueDir, readRoomsMap(storageDir), TASKS_LIMIT));
      }
      const logMatch = p.match(/^\/api\/tasks\/([^/]+)\/log$/);
      if (logMatch) {
        return sendJson(res, 200, resolveTaskLog(queueDir, decodeURIComponent(logMatch[1])));
      }
      if (p === "/api/messages") {
        return sendJson(res, 200, readMessagesTail(outputFile, MESSAGES_LIMIT));
      }
      if (p === "/api/status") {
        const hb = readHeartbeat(storageDir);
        return sendJson(res, 200, {
          bot_online: isFresh(hb, Date.now(), HEARTBEAT_MAX_AGE_MS),
          heartbeat_ts: hb,
          counts: statusCounts(queueDir),
        });
      }
      // 靜態檔(防目錄穿越)
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const full = path.join(PUBLIC_DIR, rel);
      // 縱深防禦:加 path.sep 確保只允許 PUBLIC_DIR 底下,不被同前綴的兄弟目錄(如 publicX)繞過。
      if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      const data = fs.readFileSync(full);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(full)] || "application/octet-stream" });
      return res.end(data);
    } catch (_) {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

module.exports = { createServer };
