"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectTasks, statusCounts, resolveTaskLog, readMessagesTail, parseProgress, STATUS_DIRS } = require("./aggregate");
const { readRoomsMap, translateRoom } = require("../roomsSidecar");
const { readHeartbeat, isFresh } = require("../heartbeat");
const { taskNames } = require("../taskDefs");
const { loadRules, saveRules } = require("../rules");
const { dryRunRules } = require("../trigger");
const { projectCheck } = require("../projectCheck");
const { probeRule } = require("../probe");
const { judge } = require("../judge");
const { readNotifyConfig, writeNotifyConfig } = require("../notifyConfig");
const { resolveRoomIds, writeRoomsConfig } = require("../roomsConfig");
const { ensureDir } = require("../fsUtils");

const PUBLIC_DIR = path.join(__dirname, "public");
const HEARTBEAT_MAX_AGE_MS = 60000;
const TASKS_LIMIT = 100;
const MESSAGES_LIMIT = 50;

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function safeId(id) { return id.length > 0 && !(id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")); }

// 試跑用:判斷規則的房間是否「有效監聽」——每個 room_id 是否在監聽清單、且 bot 看過(roomsMap 有名 = 看過)。
function roomMonitorStatus(rule, monitorRooms, roomsMap) {
  const ids = Array.isArray(rule.rooms) ? rule.rooms : [];
  if (!ids.length) return { status: "none", detail: "未指定房間 → 不觸發" };
  const mon = new Set(monitorRooms);
  const notMonitored = ids.filter((id) => !mon.has(id));
  if (notMonitored.length) return { status: "unmonitored", detail: `${notMonitored.length} 個房間不在監聽清單` };
  const notSeen = ids.filter((id) => !roomsMap[id]);
  if (notSeen.length) return { status: "unseen", detail: `已設監聽但 bot 尚未看過 ${notSeen.length} 個房間(可能還沒收到訊息)` };
  return { status: "ok", detail: "房間都在監聽清單且 bot 已看過" };
}

// 讀取 request body(有上限,避免被灌爆)。
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("body too large")); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

// deps = { queueDir, storageDir, outputFile, rulesPath, envRoomIds, judgeFn }
// judgeFn 可注入以利測試(預設用真 judge,會呼叫 Codex CLI)。
function createServer(deps) {
  const { queueDir, storageDir, outputFile, rulesPath, envRoomIds = [], judgeFn = (r, b) => judge(r, b) } = deps;
  return http.createServer(async (req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    try {
      if (req.method === "POST") {
        // 規則試跑:貼一段訊息文字(可選房間),回報每條規則會不會命中/觸發,不實際觸發、不跑 LLM。
        if (p === "/api/rules/dry-run") {
          let raw;
          try { raw = await readBody(req); } catch (_) { res.writeHead(413); return res.end("body too large"); }
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("bad json"); }
          const body = typeof parsed.body === "string" ? parsed.body : "";
          const roomId = typeof parsed.room_id === "string" ? parsed.room_id : undefined;
          let rules = [];
          try { rules = loadRules(rulesPath); } catch (_) {}
          const monitorRooms = resolveRoomIds(storageDir, envRoomIds);
          const roomsMap = readRoomsMap(storageDir);
          const results = dryRunRules(body, roomId, rules).map((r) => ({
            ...r,
            room_monitor: roomMonitorStatus(r, monitorRooms, roomsMap),
            project_check: r.task === "skill-dispatch" ? projectCheck(r.project_path) : null,
          }));
          return sendJson(res, 200, { results });
        }
        // LLM 二次判斷(單條規則):只跑 judge 抽參,不進專案探測。試跑後前端對「過閘的 use_llm 規則」逐條背景呼叫,
        // 把真實觸發結果 + 抽取參數漸進填回試跑表(關鍵字免費即時、LLM 判斷按需小額)。比實跑便宜(不讀專案、不派 Codex 進目錄)。
        if (p === "/api/rules/judge") {
          let raw;
          try { raw = await readBody(req); } catch (_) { res.writeHead(413); return res.end("body too large"); }
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("bad json"); }
          const body = typeof parsed.body === "string" ? parsed.body : "";
          const index = Number.isInteger(parsed.index) ? parsed.index : -1;
          let rules = [];
          try { rules = loadRules(rulesPath); } catch (_) {}
          const rule = rules[index];
          if (!rule) { res.writeHead(404); return res.end("no such rule"); }
          if (!rule.use_llm) return sendJson(res, 200, { skipped: true }); // 非 LLM 規則不需二次判斷
          try {
            const result = await judgeFn(rule, body);
            return sendJson(res, 200, { trigger: !!(result && result.trigger === true), params: (result && result.params) || {} });
          } catch (e) {
            return sendJson(res, 200, { error: String((e && e.message) || e) });
          }
        }
        // 實跑連通測試(單條 skill-dispatch 規則):judge 抽參 → 填指令 → 派 Codex 唯讀探測。
        // 會花一點 quota,故單條、按需。路徑不存在或不是目錄時先擋,不浪費 Codex 呼叫。
        if (p === "/api/rules/probe") {
          let raw;
          try { raw = await readBody(req); } catch (_) { res.writeHead(413); return res.end("body too large"); }
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("bad json"); }
          const body = typeof parsed.body === "string" ? parsed.body : "";
          const index = Number.isInteger(parsed.index) ? parsed.index : -1;
          let rules = [];
          try { rules = loadRules(rulesPath); } catch (_) {}
          const rule = rules[index];
          if (!rule) { res.writeHead(404); return res.end("no such rule"); }
          if (rule.task !== "skill-dispatch") { res.writeHead(400); return res.end("only skill-dispatch can probe"); }
          const chk = projectCheck(rule.project_path);
          if (!chk.exists || !chk.directory) return sendJson(res, 200, { blocked: true, project_check: chk });
          try {
            const result = await probeRule(rule, body);
            return sendJson(res, 200, { ...result, project_check: chk });
          } catch (e) {
            return sendJson(res, 200, { error: String((e && e.message) || e), project_check: chk });
          }
        }
        const m = p.match(/^\/api\/tasks\/([^/]+)\/(requeue|verify)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (!safeId(id)) { res.writeHead(400); return res.end("bad id"); }
          if (m[2] === "requeue") {
            const sourceStatus = ["failed", "blocked"].find((status) => fs.existsSync(path.join(queueDir, status, id + ".json")));
            const from = sourceStatus ? path.join(queueDir, sourceStatus, id + ".json") : "";
            const to = path.join(queueDir, "pending", id + ".json");
            if (!sourceStatus) { res.writeHead(404); return res.end("no requeueable task"); }
            ensureDir(path.join(queueDir, "pending"));
            try { fs.rmSync(path.join(queueDir, sourceStatus, id + ".json.error.txt"), { force: true }); } catch (_) {}
            fs.renameSync(from, to);
            return sendJson(res, 200, { ok: true });
          }
          // verify:先確認任務存在,避免替不存在的 id 建立孤兒 work 目錄
          const exists = STATUS_DIRS.some((s) => fs.existsSync(path.join(queueDir, s, id + ".json")));
          if (!exists) { res.writeHead(404); return res.end("no such task"); }
          const workDir = ensureDir(path.join(queueDir, "work", id));
          fs.writeFileSync(path.join(workDir, "verified.json"), JSON.stringify({ verified_at: new Date().toISOString() }), "utf8");
          return sendJson(res, 200, { ok: true });
        }
        res.writeHead(404); return res.end("not found");
      }
      // 規則編輯:GET 讀回 { 規則, 房間 id→名, 可用 task 名單 };PUT 整批驗證後存回。
      if (p === "/api/rules") {
        if (req.method === "GET") {
          let rules = [];
          try { rules = loadRules(rulesPath); } catch (_) {} // 檔不存在/壞掉 → 給空陣列,讓 UI 從零開始
          // monitor_rooms:規則房間 checkbox 的來源(權威監聽清單)。rooms 仍供 id→名 標籤。
          return sendJson(res, 200, {
            rules,
            rooms: readRoomsMap(storageDir),
            tasks: taskNames(),
            monitor_rooms: resolveRoomIds(storageDir, envRoomIds),
          });
        }
        if (req.method === "PUT") {
          let raw;
          try { raw = await readBody(req); } catch (_) { res.writeHead(413); return res.end("body too large"); }
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("bad json"); }
          try { saveRules(rulesPath, parsed); } catch (e) { res.writeHead(400); return res.end(String((e && e.message) || e)); }
          return sendJson(res, 200, { ok: true });
        }
        res.writeHead(405); return res.end("method not allowed");
      }
      // 任務通知設定:GET 讀回 { 設定, 房間 id→名(供下拉) };PUT 驗證後存回。
      if (p === "/api/notify-config") {
        if (req.method === "GET") {
          return sendJson(res, 200, { config: readNotifyConfig(storageDir), rooms: readRoomsMap(storageDir) });
        }
        if (req.method === "PUT") {
          let raw;
          try { raw = await readBody(req); } catch (_) { res.writeHead(413); return res.end("body too large"); }
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("bad json"); }
          try {
            const saved = writeNotifyConfig(storageDir, parsed);
            return sendJson(res, 200, { ok: true, config: saved });
          } catch (e) { res.writeHead(400); return res.end(String((e && e.message) || e)); }
        }
        res.writeHead(405); return res.end("method not allowed");
      }
      // 監聽房間清單:GET 讀回 { room_ids(檔缺回 env 後備), rooms(id→名 供即時解析) };PUT 驗證後原子存回。
      // 存回後 bot 靠 fs.watch 熱載入(見 index.js),免重啟。
      if (p === "/api/rooms-config") {
        if (req.method === "GET") {
          return sendJson(res, 200, { room_ids: resolveRoomIds(storageDir, envRoomIds), rooms: readRoomsMap(storageDir) });
        }
        if (req.method === "PUT") {
          let raw;
          try { raw = await readBody(req); } catch (_) { res.writeHead(413); return res.end("body too large"); }
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("bad json"); }
          try {
            const saved = writeRoomsConfig(storageDir, parsed);
            return sendJson(res, 200, { ok: true, room_ids: saved.room_ids });
          } catch (e) { res.writeHead(400); return res.end(String((e && e.message) || e)); }
        }
        res.writeHead(405); return res.end("method not allowed");
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
