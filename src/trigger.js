"use strict";
const { matchRules } = require("./matcher");

// 規則的房間範圍判斷:rule.rooms 缺省/空 = 全部房間;否則該訊息的 room_id 須落在清單內。
// 只認 room_id(全域唯一);房間顯示名可能重複,不拿來比對以免靜默誤觸發。
function ruleMatchesRoom(rule, roomId) {
  if (!Array.isArray(rule.rooms) || rule.rooms.length === 0) return true;
  return rule.rooms.includes(roomId);
}

// 規則是否啟用:enabled === false 才視為停用;缺省/true 皆為啟用(向後相容)。
function ruleEnabled(rule) {
  return rule.enabled !== false;
}

// 觸發管線(注入 judgeFn / enqueueFn / logger 以利測試與替換)。
// deps = { rules, judgeFn(rule, body)->{trigger,params}, enqueueFn(task)->filepath, logger }
// 對一則正規化訊息 rec:關鍵字粗篩 → 房間範圍過濾 → 逐條決定直接觸發或經 LLM → 觸發則 enqueue。
// 單條規則的任何錯誤只記 log,不中斷其他規則,也不向外丟出。
async function runTriggerPipeline(rec, deps) {
  const { rules, judgeFn, enqueueFn, logger } = deps;
  const body = rec && rec.content && rec.content.body;
  const roomId = rec && rec.room_id;
  const matched = matchRules(body, rules)
    .filter(ruleEnabled)
    .filter((rule) => ruleMatchesRoom(rule, roomId));
  for (const rule of matched) {
    try {
      let params = {};
      if (rule.use_llm) {
        const result = await judgeFn(rule, body);
        if (!result || result.trigger !== true) {
          logger.log(`[trigger] 規則 ${rule.name} LLM 判定不觸發`);
          continue;
        }
        params = result.params || {};
      }
      const task = {
        rule: rule.name,
        task: rule.task,
        params,
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
  return list.map((rule) => {
    const keyword_hit = matchRules(body, [rule]).length > 0;
    const enabled = ruleEnabled(rule);
    const room_ok = ruleMatchesRoom(rule, roomId);
    const passesGate = keyword_hit && enabled && room_ok;
    return {
      name: rule.name,
      task: rule.task,
      use_llm: !!rule.use_llm,
      keyword_hit,
      enabled,
      room_ok,
      triggers: rule.use_llm ? false : passesGate, // 非 LLM:過閘即觸發
      needs_llm: !!rule.use_llm && passesGate,      // LLM:過閘則會送 LLM 判斷
    };
  });
}

module.exports = { runTriggerPipeline, ruleMatchesRoom, ruleEnabled, dryRunRules };
