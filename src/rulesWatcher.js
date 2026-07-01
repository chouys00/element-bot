"use strict";
const fs = require("fs");
const path = require("path");
const { loadRules } = require("./rules");

// 重讀並驗證規則:成功回新規則,失敗回原規則(壞檔不讓 bot 清空/崩潰)。
// 純粹靠回傳值表達結果,呼叫端負責 swap,故好測。
function reloadRules(rulesPath, currentRules, logger) {
  try {
    const next = loadRules(rulesPath);
    logger.log(`[rules] 已熱載入 ${next.length} 條規則`);
    return next;
  } catch (e) {
    logger.warn(`[rules] 規則重載失敗,沿用前一版 ${currentRules.length} 條:${e.message}`);
    return currentRules;
  }
}

// 監看 rules.json 變動,debounce 後呼叫 onChange。
// 監看「所在目錄」而非檔案本身:saveRules 用 tmp+rename 原子替換,
// 直接 watch 檔案在 rename 後常失去 handle;watch 目錄並以檔名過濾才穩。
// 回傳 fs.FSWatcher(呼叫 .close() 可停)。
function watchRules(rulesPath, onChange, opts = {}) {
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 300;
  const dir = path.dirname(rulesPath);
  const base = path.basename(rulesPath);
  let timer = null;
  const watcher = fs.watch(dir, (event, filename) => {
    // filename 在某些平台可能為 null → 不過濾,照樣觸發;有值則只認 rules.json。
    if (filename && path.basename(filename) !== base) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return watcher;
}

module.exports = { reloadRules, watchRules };
