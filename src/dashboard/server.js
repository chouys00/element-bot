"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, parseProgress } = require("./aggregate");
const { readRoomsMap, translateRoom } = require("../roomsSidecar");
const { readHeartbeat, isFresh } = require("../heartbeat");

const PUBLIC_DIR = path.join(__dirname, "public");
const HEARTBEAT_MAX_AGE_MS = 60000;
const TASKS_LIMIT = 100;
const MESSAGES_LIMIT = 50;

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function safeId(id) { return !(id.includes("..") || id.includes("/") || id.includes("\\")); }

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// deps = { queueDir, storageDir, outputFile }
function createServer(deps) {
  const { queueDir, storageDir, outputFile } = deps;
  return http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    try {
      if (req.method === "POST") {
        const m = p.match(/^\/api\/tasks\/([^/]+)\/(requeue|verify|open)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (!safeId(id)) { res.writeHead(400); return res.end("bad id"); }
          if (m[2] === "requeue") {
            const from = path.join(queueDir, "failed", id + ".json");
            const to = path.join(queueDir, "pending", id + ".json");
            if (!fs.existsSync(from)) { res.writeHead(404); return res.end("no failed task"); }
            fs.mkdirSync(path.join(queueDir, "pending"), { recursive: true });
            try { fs.rmSync(path.join(queueDir, "failed", id + ".json.error.txt"), { force: true }); } catch (_) {}
            fs.renameSync(from, to);
            return sendJson(res, 200, { ok: true });
          }
          if (m[2] === "open") {
            const prog = parseProgress(queueDir, id);
            const openPath = prog.summary && prog.summary.openPath;
            const workRoot = path.join(queueDir, "work");
            const resolved = openPath ? path.resolve(openPath) : "";
            if (!resolved || !(resolved === path.resolve(workRoot) || resolved.startsWith(path.resolve(workRoot) + path.sep))) {
              res.writeHead(400); return res.end("bad path");
            }
            const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
            require("child_process").spawn(opener, [resolved], { detached: true, stdio: "ignore" }).unref();
            return sendJson(res, 200, { ok: true });
          }
          // verify:寫驗收標記
          const workDir = path.join(queueDir, "work", id);
          fs.mkdirSync(workDir, { recursive: true });
          fs.writeFileSync(path.join(workDir, "verified.json"), JSON.stringify({ verified_at: new Date().toISOString() }), "utf8");
          return sendJson(res, 200, { ok: true });
        }
        res.writeHead(404); return res.end("not found");
      }
      if (p === "/api/tasks") {
        return sendJson(res, 200, collectTasks(queueDir, readRoomsMap(storageDir), TASKS_LIMIT));
      }
      const logMatch = p.match(/^\/api\/tasks\/([^/]+)\/log$/);
      if (logMatch) {
        const id = decodeURIComponent(logMatch[1]);
        // 防穿越:decodeURIComponent 後的 id 可能含 ../ 或分隔符,擋掉避免讀到 queue 外的檔。
        if (id.includes("..") || id.includes("/") || id.includes("\\")) {
          res.writeHead(400);
          return res.end("bad id");
        }
        return sendJson(res, 200, resolveTaskLog(queueDir, id));
      }
      const progMatch = p.match(/^\/api\/tasks\/([^/]+)\/progress$/);
      if (progMatch) {
        const id = decodeURIComponent(progMatch[1]);
        if (id.includes("..") || id.includes("/") || id.includes("\\")) {
          res.writeHead(400); return res.end("bad id");
        }
        return sendJson(res, 200, parseProgress(queueDir, id));
      }
      if (p === "/api/messages") {
        const rooms = readRoomsMap(storageDir);
        const msgs = readMessagesTail(outputFile, MESSAGES_LIMIT).map((m) => ({ ...m, room_name: translateRoom(m.room_id, rooms) }));
        return sendJson(res, 200, msgs);
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
