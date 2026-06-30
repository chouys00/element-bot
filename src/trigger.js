"use strict";
const { matchRules } = require("./matcher");
const { translateRoom } = require("./roomsSidecar");

// 規則的房間範圍判斷:rule.rooms 缺省/空 = 全部房間;否則該訊息的 room_id
// 或其顯示名須落在清單內(同時接受 room_id 與顯示名,避免顯示名未學到時被卡死)。
function ruleMatchesRoom(rule, roomId, roomsMap) {
  if (!Array.isArray(rule.rooms) || rule.rooms.length === 0) return true;
  if (rule.rooms.includes(roomId)) return true;
  const name = translateRoom(roomId, roomsMap);
  return name !== roomId && rule.rooms.includes(name);
}

// 觸發管線(注入 judgeFn / enqueueFn / logger 以利測試與替換)。
// deps = { rules, judgeFn(rule, body)->{trigger,params}, enqueueFn(task)->filepath, logger, roomsMap? }
// 對一則正規化訊息 rec:關鍵字粗篩 → 房間範圍過濾 → 逐條決定直接觸發或經 LLM → 觸發則 enqueue。
// 單條規則的任何錯誤只記 log,不中斷其他規則,也不向外丟出。
async function runTriggerPipeline(rec, deps) {
  const { rules, judgeFn, enqueueFn, logger, roomsMap } = deps;
  const body = rec && rec.content && rec.content.body;
  const roomId = rec && rec.room_id;
  const matched = matchRules(body, rules).filter((rule) => ruleMatchesRoom(rule, roomId, roomsMap));
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

module.exports = { runTriggerPipeline, ruleMatchesRoom };
