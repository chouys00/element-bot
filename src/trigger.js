"use strict";
const { matchRules } = require("./matcher");

// 觸發管線(注入 judgeFn / enqueueFn / logger 以利測試與替換)。
// deps = { rules, judgeFn(rule, body)->{trigger,params}, enqueueFn(task)->filepath, logger }
// 對一則正規化訊息 rec:粗篩 → 逐條命中規則決定直接觸發或經 LLM → 觸發則 enqueue。
// 單條規則的任何錯誤只記 log,不中斷其他規則,也不向外丟出。
async function runTriggerPipeline(rec, deps) {
  const { rules, judgeFn, enqueueFn, logger } = deps;
  const body = rec && rec.content && rec.content.body;
  const matched = matchRules(body, rules);
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

module.exports = { runTriggerPipeline };
