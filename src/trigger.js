"use strict";
const { matchRules } = require("./matcher");
const { ruleConfigurationError } = require("./rules");

// 規則的房間範圍判斷:rule.rooms 缺省/空 = 不觸發任何房間(規則必須明確指定房間才生效);
// 否則該訊息的 room_id 須落在清單內。避免「忘了填房間」的規則在全部房間亂觸發。
// 只認 room_id(全域唯一);房間顯示名可能重複,不拿來比對以免靜默誤觸發。
function ruleMatchesRoom(rule, roomId) {
  if (!Array.isArray(rule.rooms) || rule.rooms.length === 0) return false;
  return rule.rooms.includes(roomId);
}

// 規則是否啟用:enabled === false 才視為停用;缺省/true 皆為啟用(向後相容)。
function ruleEnabled(rule) {
  return rule.enabled !== false;
}

// 把指令模板裡的 {佔位} 用 params 填掉(支援中文 key,如 {路徑})。
// 找不到對應 param 的佔位填空字串;無佔位則原樣回傳。供 skill-dispatch 通用任務把
// LLM 擷取出的關鍵訊息組成專案 skill 認得的指令(如 "/i18n {路徑}" → "/i18n pages/activity")。
function fillTemplate(template, params) {
  return String(template).replace(/\{([^}]+)\}/g, (_, key) => {
    const k = key.trim();
    return params && params[k] != null ? String(params[k]) : "";
  });
}

// 觸發管線(注入 judgeFn / enqueueFn / logger 以利測試與替換)。
// deps = { rules, judgeFn(rule, body)->{trigger,params}, enqueueFn(task)->filepath, logger,
//          judgeStatus?: { start(rule, rec)->id, finish(id, {result, detail?}) } }
// judgeStatus 選填:把 LLM 判斷的進行中/不觸發/失敗落地成紀錄檔,dashboard 才分得清
// 「沒收到 vs 判斷中 vs LLM 判定不觸發 vs 判斷失敗」(見 judgeStatus.js)。
// 對一則正規化訊息 rec:關鍵字粗篩 → 房間範圍過濾 → 逐條決定直接觸發或經 LLM → 觸發則 enqueue。
// 單條規則的任何錯誤只記 log,不中斷其他規則,也不向外丟出。
async function runTriggerPipeline(rec, deps) {
  const { rules, judgeFn, enqueueFn, logger, judgeStatus } = deps;
  const body = rec && rec.content && rec.content.body;
  const roomId = rec && rec.room_id;
  const matched = matchRules(body, rules)
    .filter(ruleEnabled)
    .filter((rule) => ruleMatchesRoom(rule, roomId));
  for (const rule of matched) {
    try {
      const configurationError = ruleConfigurationError(rule);
      if (configurationError) {
        logger.error(`[trigger] 規則 ${rule.name} 設定錯誤，已停用:`, configurationError);
        continue;
      }
      let params = {};
      if (rule.use_llm) {
        const jid = judgeStatus ? judgeStatus.start(rule, rec) : null;
        let result;
        try {
          result = await judgeFn(rule, body);
        } catch (err) {
          if (jid != null) judgeStatus.finish(jid, { result: "error", detail: String((err && err.message) || err) });
          throw err;
        }
        if (!result || result.trigger !== true) {
          if (jid != null) judgeStatus.finish(jid, { result: "rejected" });
          logger.log(`[trigger] 規則 ${rule.name} LLM 判定不觸發`);
          continue;
        }
        if (jid != null) judgeStatus.finish(jid, { result: "triggered" });
        params = result.params || {};
      }
      const task = {
        rule: rule.name,
        task: rule.task,
        params,
        // 通用任務 skill-dispatch 用:專案路徑原樣帶入;指令模板用 params 填好後帶入。
        // 兩者為選填(內建任務不需要),故只在規則有設時才加進 task。
        ...(rule.project_path ? { project_path: rule.project_path } : {}),
        ...(rule.command ? { command: fillTemplate(rule.command, params) } : {}),
        ...(rule.target_branch ? { target_branch: fillTemplate(rule.target_branch, params) } : {}),
        source: {
          room_id: rec.room_id,
          sender: rec.sender,
          event_id: rec.event_id,
          body,
        },
        enqueued_at: new Date().toISOString(),
      };
      const file = enqueueFn(task);
      logger.log(`[trigger] 規則 ${rule.name} 觸發 → ${file}`);
    } catch (err) {
      logger.error(`[trigger] 規則 ${rule.name} 處理失敗(略過):`, err.message);
    }
  }
}

// 試跑(dry-run):對一段訊息文字,逐條規則回報「若真的收到這則訊息會怎樣」,不實際觸發、不跑 LLM。
// 用與觸發管線相同的判斷(matchRules / ruleEnabled / ruleMatchesRoom),確保預覽結果與 bot 實際行為一致。
// use_llm 規則:關鍵字+啟用+房間都過才會「送 LLM 二次判斷」,最終是否觸發仍看 LLM(此處不實跑,標 needs_llm)。
function dryRunRules(body, roomId, rules) {
  const list = Array.isArray(rules) ? rules : [];
  // roomId 未指定(UI「全部房間」)= 不比對特定房間:只要規則本身有設房間就算通過房間檢查
  //(等於「假設在該規則的目標房間內」,聚焦關鍵字/啟用);有指定房間才真的比對 room_id。
  //(沒設房間的規則本就永遠不觸發,故不因「全部房間」放行。)
  const roomSpecified = typeof roomId === "string" && roomId.length > 0;
  return list.map((rule) => {
    const keyword_hit = matchRules(body, [rule]).length > 0;
    const enabled = ruleEnabled(rule);
    const hasRooms = Array.isArray(rule.rooms) && rule.rooms.length > 0;
    const room_ok = roomSpecified ? ruleMatchesRoom(rule, roomId) : hasRooms;
    const configuration_error = ruleConfigurationError(rule);
    const passesGate = keyword_hit && enabled && room_ok && !configuration_error;
    const command = rule.command || null;
    return {
      name: rule.name,
      task: rule.task,
      use_llm: !!rule.use_llm,
      keyword_hit,
      enabled,
      room_ok,
      configuration_error,
      triggers: rule.use_llm ? false : passesGate, // 非 LLM:過閘即觸發
      needs_llm: !!rule.use_llm && passesGate,      // LLM:過閘則會送 LLM 判斷
      // skill-dispatch 試跑顯示用:原始指令模板、是否含 {佔位}(帶佔位需實跑 LLM 才有真實值)、專案路徑、房間。
      command,
      has_placeholder: !!command && /\{[^}]+\}/.test(command),
      project_path: rule.project_path || null,
      target_branch: rule.target_branch || null,
      rooms: Array.isArray(rule.rooms) ? rule.rooms : [],
    };
  });
}

module.exports = { runTriggerPipeline, ruleMatchesRoom, ruleEnabled, dryRunRules, fillTemplate };
