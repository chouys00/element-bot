# 變更紀錄

本專案版本遵循 `主.次.修` 格式。新增功能遞增次版號(1.X),全數規劃功能完成後進 2.0 里程碑。

## [未發布]

規劃中(依施作順序):
- 任務成本/耗時統計
- 稽核日誌

備註(留待日後):
- 真正的 bot 掉線偵測(需獨立 watchdog 常駐,另開一組 Matrix 登入)。目前僅 bot 自身「上線/下線」盡力而為通知。
- 通知第二行摘要開關(目前固定顯示;摘要為 summarize 步驟固定產出,不耗 token)。

## [1.7.0] - 2026-07-06

### 新增
- **連通性試跑(規則試跑強化)**:在 dashboard 就能確認整條自動化是否打通,不必真的發訊息。
  - 試跑結果每條規則新增三欄(靜態、零 quota):**房間監聽**(房間是否在監聽清單且 bot 看過)、**送出指令**(固定指令直接顯示;帶 `{佔位}` 顯示模板並標「點實跑看真實值」)、**專案健檢**(skill-dispatch 的 `project_path` 是否存在/是 git/乾淨)。
  - skill-dispatch 規則可按「🔌 實跑」做**按需連通測試**:跑一次 LLM 抽參填出真實指令,並派 claude **唯讀**進專案回報「我在哪、收到什麼指令、會用哪個 skill」,但不執行、不改檔、不 commit。
  - 新增 [projectCheck.js](src/projectCheck.js)(路徑健檢,回報而非丟錯)、[probe.js](src/probe.js)(judge 抽參 + claude 唯讀探測,用非阻塞 `spawn` 避免凍住 dashboard)。
  - `trigger.js` 的 `dryRunRules` 帶出 command/佔位/專案路徑;新增 `POST /api/rules/probe`(單條實跑,路徑不健康先擋、不浪費 claude 呼叫)。
  - 試跑結果欄位順序調整為「規則/觸發判斷/房間監聽/**專案健檢**/**送出指令**/實跑」,讓「送出指令(模板)」緊鄰「實跑」(真實值),閱讀順序對齊管線。
  - 「實跑」按鈕在**這則訊息不會觸發此規則**或**專案路徑不健康**時停用(灰底 + 滑過顯示原因),避免白跑浪費 quota;仍會觸發或待送 LLM 判斷、僅房間未監聽時維持可按。

### 已知限制
- 「實跑」會讓 dashboard 程序 spawn 無人 claude(`--dangerously-skip-permissions`);本機(127.0.0.1)用可接受,**開放遠端前必須先加登入驗證**(既有待辦,此功能讓它更重要)。

## [1.6.0] - 2026-07-02

### 新增
- **通用任務 `skill-dispatch` + 規則專案/指令欄位**:讓一條規則能監聽訊息 → 擷取關鍵資訊 → 轉成指令 → 派發 headless claude 到**任意絕對路徑**的專案,由 claude 用該專案的 `.claude/skills` 機制識別並執行。加新專案/新 skill 只需加規則、**不必改程式碼**。
  - `taskDefs.js` 新增通用任務 `skill-dispatch`(「計程車」模型):專案路徑(`project_path`)與指令(`command`)都由規則資料帶入,任務定義本身固定;不做 root 逸出檢查,存在性與 git 乾淨由 executor 的 `prepare` 把關。
  - 規則新增選填欄位 `project_path`、`command`(`rules.js` 驗證);`command` 支援 `{欄位}` 佔位,用 LLM 抽取的 `params` 填入(如 `/i18n {路徑}` → `/i18n pages/activity`)。
  - `trigger.js` 新增 `fillTemplate()` 做佔位填充,組任務時帶入 `project_path` 與填好的 `command`。
  - 規則編輯 UI(`rules.html`)新增「專案路徑」「指令 (command)」欄位,僅在任務選 `skill-dispatch` 時顯示。
  - 端到端驗證通過:真 claude 能識別專案 skill;element-bot 管線能派發、動手改檔、狀態更新 `done`,且遵守禁止提交。

### 已知限制
- 主控台任務列表的「開啟(專案資料夾)」按鈕白名單目前僅認 `FTL_ROOT`/`DEMO_ROOT`;`skill-dispatch` 的任意路徑專案按「開啟」會被擋(待後續放寬)。

## [1.5.0] - 2026-07-02

### 新增
- **監聽房間管理 UI(#7)**:把「bot 監聽哪些房間」從 `.env` 搬到 dashboard,可編輯 + 熱載入。
  - 新增設定檔 `storage/rooms-config.json`(`{ room_ids: [...] }`)與讀寫模組 `roomsConfig.js`(驗證 + 原子寫 + 熱載入沿用前一版壞檔不崩)。
  - 主控台新增「🏠 監聽房間」彈窗:textarea 一行一個 room_id(可貼入 bot 尚未看過的新房間),即時解析房名回饋(已知 ✅ 房名、未知 ⚠️ 以 ID 生效)。
  - 後端 `GET/PUT /api/rooms-config`;`GET /api/rules` 一併回傳 `monitor_rooms` 監聽清單。
  - 規則編輯器房間 checkbox 來源從 `rooms.json`(bot 看過的房間)改為「監聽清單」,UI 層強制規則房間為監聽清單的子集;規則若含已移出監聽的房間,仍列出並標 ⚠️「已不在監聽清單」不靜默丟掉。

### 變更(行為調整)
- bot 監聽清單改由 `rooms-config.json` 決定並經 `fs.watch` 熱載入(新增/移除房間免重啟);`.env` 的 `MATRIX_ROOM_IDS` 僅在該檔不存在時作為初始值/後備,不硬移除以免炸現有部署。
- `MATRIX_ROOM_IDS` 由必填改為非必填(監聽清單可純由 dashboard 管理);清單為空時 bot 啟動會警告但不崩潰。
- 移除 Matrix sync 的 server-side room filter,改由 `shouldCapture` 在 client 端以熱載入清單過濾。換取乾淨的即時熱載入;`to_device`(E2EE 金鑰交換)為 sync 頂層欄位不受影響,解密照常。

## [1.4.0] - 2026-07-02

### 新增
- 規則編輯 UI(`rules.html`):在 dashboard 直接新增/編輯/刪除/啟用停用規則,免手改 `config/rules.json`。
  - 後端 `GET/PUT /api/rules`(整批驗證後原子寫入),搭配 bot `fs.watch` 熱載入,存檔即生效免重啟。
  - 房間範圍用 checkbox 從已知房間清單勾選;規則裡若有清單外的 room_id(bot 尚未看過/已移出監聽),仍列出並標 ⚠️ 不靜默丟掉。
  - 房名縮短顯示:`Empty room (was @kevin.hce:ims.opscloud.info)` → `Empty room (was @kevin.hce)`。
  - (註:房間欄位曾短暫改為 textarea,後依「MATRIX_ROOM_IDS 才是權威清單、rule.rooms 是子集」的定案改回 checkbox;待 #7 完成後 checkbox 來源將從 rooms.json 換為監聽清單。)

### 變更(行為調整)
- **規則房間範圍語意反轉**:`rules[].rooms` 留空/缺省由「套用全部房間」改為「不觸發任何房間」。規則須明確指定房間才生效,避免忘填房間的規則在所有房間亂觸發。
  - `saveRules` 存檔時強制:啟用中的規則必須至少一個房間(停用規則可留空)。`loadRules`/熱載入不強制,舊檔或手改檔案仍可載入(壞檔沿用前一版)。

## [1.3.0] - 2026-07-01

### 新增
- 任務通知:worker 任務結束(成功/失敗)發一則訊息到指定房間,讓人知道「誰在哪觸發了什麼、結果如何」。
  - 架構:worker 沒有 Matrix client,故任務結束寫 `queue/notify/<id>.json`,由 bot `fs.watch` 監看 → 套範本 → `sendTextMessage` → 刪檔;啟動時先清離線期間累積的通知。
  - 訊息範本(範本 B + 免費短摘要,兩行):`✅「規則名」完成 · 〈房間名〉@發送者` + 第二行摘要(成功取自 summarize 步驟輸出,失敗取 error 首段並截斷 200 字,皆不耗 token)。
  - 通知設定存於 `storage/notify-config.json`(`enabled` / `room_id` / `notify_on`);bot 發送前現讀,故改設定免重啟 bot。
  - dashboard 新增「🔔 通知設定」彈窗:啟用開關、房間下拉(取自已知房間)、通知時機(全部 / 只失敗)。新增 `GET/PUT /api/notify-config`。
  - bot 生命週期通知:啟動發「🟢 已上線」;收到中止訊號發「🔴 下線中」(盡力而為)。
  - `notify_on: failed_only` 已實作可切換(降噪);真正的 crash 掉線偵測留待日後 watchdog。

## [1.2.0] - 2026-07-01

### 新增
- 規則試跑(dry-run):在 dashboard 貼一段訊息文字(可選房間),即時預覽每條規則會不會命中/觸發,不用真的去房間發訊息。
  - 新增 `POST /api/rules/dry-run`,沿用觸發管線同一套判斷(關鍵字 / 啟用 / 房間),確保預覽與 bot 實際行為一致。
  - `use_llm` 規則:關鍵字+啟用+房間過閘後標示「會送 LLM 二次判斷」,此處不實跑 LLM(不燒 quota)。
  - `rules.html` 新增可收合的「🧪 規則試跑」面板。

### 改善
- 崩潰重試保險:任務被回收重跑達上限(`MAX_TASK_ATTEMPTS`,預設 3)仍中斷,不再無限重撿,改送 `failed/` 待人工。
  - `state.attempt` 由 agentExecutor 每次開跑遞增,硬崩潰亦計入;`recoverProcessing` 於啟動回收時據此判斷。

## [1.1.0] - 2026-07-01

### 新增
- 規則啟用開關(enabled):每條規則可停用而不刪除,保留設定但不觸發。
  - 規則清單新增「啟用」欄,即點即存的開關;停用列變暗。
  - 編輯面板新增「啟用」勾選(新規則預設啟用)。
  - schema 新增選填 `enabled` 布林欄位;缺省視為啟用(向後相容,舊規則不受影響)。
  - 觸發管線在關鍵字比對後過濾停用規則。

## [1.0.0] - 2026-07-01

穩定基準版。此前功能一次記錄:

- Matrix E2EE 房間即時監聽,解密後寫入 JSONL
- 關鍵字規則觸發 + 可選 LLM 二次判斷/抽參數
- 房間範圍限定規則(rooms)
- 檔案佇列任務派發(pending/processing/done/failed),斷點續跑與啟動回收
- worker 以 `claude -p` 無人值守執行 skill 任務
- 監控台 dashboard:任務進度、日誌、驗收動作(開檔/驗收/重跑)
- 規則編輯 UI,存檔即熱載入(fs.watch),「套用」立即儲存
