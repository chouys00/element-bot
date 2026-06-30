# Element Bot — 關鍵字觸發 AI Agent 設計 Spec

**Date:** 2026-06-25
**Status:** Approved
**前置:** 建立在 [2026-06-18-element-bot-design.md](./2026-06-18-element-bot-design.md) 的即時監聽+解密基礎之上(現已改用 matrix-js-sdk 實作,見 src/)。

## 目標

在現有 element-bot(長駐監聽指定房間、解密、寫 `output/messages.jsonl`)之上,**新增一層觸發管線**:當監聽到的訊息命中規則時,自動(可選擇性地經 LLM 語意判斷後)產生一筆任務,交由獨立 worker 執行特定 AI agent(目前等同使用者手動觸發的 Claude skill)。

核心原則:**不改動現有監聽/解密/寫 JSONL 邏輯**;觸發判斷失敗絕不影響訊息擷取。

---

## 已定案的決策

| 主題 | 決策 | 理由 |
|------|------|------|
| 監聽持續性 | 沿用現有架構,本就長駐監聽,不需改動 | bot 啟動後即進入 sync 迴圈直到 Ctrl+C |
| 觸發架構 | **佇列 + 獨立 worker**(解耦) | 任務可能跑數十秒~數分鐘;監聽端必須輕量不卡;怕漏訊息 |
| 判斷方式 | **關鍵字粗篩(程式)→ 每條規則可選配 LLM 細判** | 穩定性/零成本放粗篩;語意彈性放 LLM;逐條決定 |
| 規則定義 | **JSON 設定檔 `config/rules.json`** | 改規則不動程式;非工程師也可維護 |
| LLM | **Claude Haiku 4.5**(`claude-haiku-4-5`),僅 `use_llm:true` 的規則會呼叫 | 輕量判斷快又便宜;有關鍵字粗篩當成本閘門 |
| 佇列 | **檔案資料夾**(`queue/pending` → `done`/`failed`) | 最樸素可靠;bot/worker 任一當掉任務都不掉 |
| executor | 第一版做 **dry-run(印出/記 log)**,留可插拔介面 | agent 形式未定;先把整條管線跑通,之後再插真正呼叫 |
| 並發 | 單 worker 逐筆處理 | 夠用且好除錯(YAGNI) |

---

## 架構與資料流

```
現有: 訊息 → 解密 → normalize → 寫 messages.jsonl
                              │
新增:                          └→ 觸發管線(掛在 processEvent 寫完之後)
  ┌───────────────────────────────────────────────────────────┐
  │ 1. 關鍵字粗篩  matcher.js（rules.json,純函式,確定性）      │
  │       命中? ──No──> 丟棄                                    │
  │       │Yes                                                  │
  │ 2. 這條規則 use_llm?                                        │
  │       ─No──> 直接觸發                                       │
  │       │Yes                                                  │
  │ 3. LLM 細判 judge.js (Claude Haiku 4.5):該觸發?抽參數     │
  │       ─No / 失敗 ──> 丟棄(記 log)                          │
  │       │Yes                                                  │
  │ 4. enqueue:寫 queue/pending/<ts>-<rule>.json               │
  └───────────────────────────────────────────────────────────┘

  獨立程序 worker.js
  ┌───────────────────────────────────────────────────────────┐
  │ 輪詢 queue/pending/ → 逐筆交給 executor                     │
  │   executor(可插拔):v1 = dry-run 印出;之後 = 呼叫 agent    │
  │   成功 → 移到 queue/done/;失敗 → queue/failed/(含錯誤)     │
  └───────────────────────────────────────────────────────────┘
```

兩個程序:
- **bot**(現有 `src/index.js` + 新增觸發管線):監聽、解密、寫 JSONL、判斷是否觸發、enqueue。
- **worker**(新增 `src/worker.js`,獨立啟動):消化佇列、執行 agent。

---

## 各元件設計

### ① 規則設定 `config/rules.json`

```json
[
  {
    "name": "deploy",
    "keywords": ["部署", "上線", "deploy"],
    "task": "deploy-skill",
    "use_llm": true,
    "intent": "有人要求部署或詢問上線流程時才觸發;在抱怨或回顧過去的部署則不要",
    "extract": ["環境", "服務名稱"]
  },
  {
    "name": "report",
    "keywords": ["週報", "report"],
    "task": "report-skill",
    "use_llm": false
  }
]
```

欄位:

| 欄位 | 必填 | 說明 |
|------|------|------|
| `name` | ✅ | 規則識別名(用於佇列檔名、log) |
| `keywords` | ✅ | 粗篩關鍵字(任一命中即過第一關);大小寫不敏感 |
| `task` | ✅ | 要觸發的任務代號(傳給 executor) |
| `use_llm` | ✅ | `false`=命中即觸發(確定性、零成本);`true`=再經 LLM 細判 |
| `intent` | use_llm 時必填 | 給 LLM 判斷「該不該觸發」的語意描述 |
| `extract` | 選填 | 要 LLM 從訊息抽出的參數欄位名清單 |

### ② 觸發管線(bot 內新增)

- `src/matcher.js` — 純函式。輸入(訊息正規化物件, rules),輸出命中的規則清單(關鍵字比對)。沿用 `handler.js` 的純函式可測試風格。
- `src/judge.js` — 呼叫 Claude Haiku 4.5。輸入(訊息, 規則),輸出 `{ trigger: boolean, params: {...} }`。只有 `use_llm:true` 的規則會走到。用官方 `@anthropic-ai/sdk`,`messages.create`,結構化輸出(`output_config.format` 以 json_schema 約束回傳)。LLM 呼叫失敗 → 視為不觸發並記 log(不讓例外往上炸到監聽端)。
- `src/enqueue.js` — 把(原訊息、規則 name/task、抽出的 params、時間)寫成 `queue/pending/<ts>-<rule>.json`。
- 串接點:在 `src/index.js` 的 `processEvent` 寫完 JSONL 之後,以 try/catch 包住呼叫觸發管線,**任何錯誤只記 log,不影響擷取**。

### ③ 佇列 `queue/`(檔案式)

```
queue/
  pending/   ← enqueue 寫入;worker 待處理
  done/      ← 成功處理完移入
  failed/    ← 處理失敗移入(附 error 資訊)
```

任務檔內容範例:
```json
{
  "rule": "deploy",
  "task": "deploy-skill",
  "params": { "環境": "production", "服務名稱": "api-gateway" },
  "source": { "room_id": "...", "sender": "...", "event_id": "...", "body": "..." },
  "enqueued_at": "2026-06-25T..."
}
```

### ④ worker(獨立程序 `src/worker.js`)

- 輪詢 `queue/pending/`(簡單 interval 掃描;處理中可先 rename 加鎖避免重複)。
- 每筆交給 **executor**(`src/executors/`):
  - **v1 預設 `dryRunExecutor`**:把任務內容印出/記 log,直接視為成功。用來驗證整條管線。
  - 之後新增 `agentExecutor`:實際呼叫 Claude skill / 跑 agent 腳本。**只動這一格,bot 與佇列格式不變。**
- 處理結果:成功移 `queue/done/`,失敗移 `queue/failed/`(附 error)。

### ⑤ 設定 / 金鑰

- `.env` 新增 `ANTHROPIC_API_KEY`(僅 LLM 判斷用;與既有 Matrix 機密同檔,已被 `.gitignore` 排除)。
- 規則檔路徑、佇列目錄、輪詢間隔等集中在 config(沿用 `src/config.js` 風格,新增對應欄位)。

---

## 檔案結構(新增/異動)

```
config/rules.json          # 新增:規則設定
queue/{pending,done,failed} # 新增:檔案佇列(gitignore)
src/matcher.js             # 新增:關鍵字粗篩(純函式)
src/judge.js               # 新增:LLM 細判(Claude Haiku 4.5)
src/enqueue.js             # 新增:寫任務到佇列
src/worker.js              # 新增:獨立 worker 程序
src/executors/dryRun.js    # 新增:v1 dry-run executor
src/index.js               # 異動:processEvent 後串接觸發管線
src/config.js              # 異動:新增 rules/queue/api key 設定
.env / .env.example        # 異動:新增 ANTHROPIC_API_KEY
package.json               # 異動:新增 @anthropic-ai/sdk 依賴、worker 啟動 script
test/                      # 新增:matcher、enqueue 等純函式單元測試
```

---

## 刻意不做(YAGNI)

- 不做 HTTP 服務 / webhook / 資料庫——檔案佇列足矣。
- v1 不實作真正的 agent 呼叫——executor 留插槽,先驗證管線。
- 不做並發 worker、不做分散式佇列——單 worker 逐筆。
- 不在粗篩層做複雜程式邏輯(發送者/時間判斷)——需要語意就交 LLM,粗篩維持關鍵字。

---

## 驗收標準(v1)

1. 在 `config/rules.json` 設一條 `use_llm:false` 規則,於目標房間發含關鍵字訊息 → `queue/pending/` 出現對應任務檔。
2. 啟動 worker(dry-run)→ 任務被印出並移到 `queue/done/`。
3. 設一條 `use_llm:true` 規則,發「正面」訊息會觸發、發「回顧過去」訊息不觸發(驗證 LLM 細判)。
4. LLM API 故意給錯 key → 該則不觸發但**監聽與 JSONL 擷取照常運作**(隔離性)。
5. `npm test` 通過(matcher / enqueue 純函式測試)。
