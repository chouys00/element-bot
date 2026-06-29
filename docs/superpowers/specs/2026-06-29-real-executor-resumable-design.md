# Element Bot — 真 executor + 驗證台(可中斷續跑)設計 Spec

**Date:** 2026-06-29
**Status:** Approved
**前置:** 建立在
[2026-06-25-keyword-trigger-agent-design.md](./2026-06-25-keyword-trigger-agent-design.md)(觸發管線 + 檔案佇列 + 可插拔 executor)
與 [2026-06-26-ui-dashboard-design.md](./2026-06-26-ui-dashboard-design.md)(解耦監控台、`queue/logs/<id>.log` 約定)之上。

## 目標

把整條觸發管線的**最後一棒**補起來:將目前的 dry-run executor 換成**真正執行 skill 的 executor**,
並把**監控台升級成能在畫面上驗收的驗證台**。第一個接通的真實任務**會修改檔案**,因此需要與 bot_gui
同等級的安全網(隔離副本 + git 安全檢查 + verify 把關)。

最關鍵的硬需求:**任務可中斷續跑**。當 `claude -p` 額度用完或程序中斷,下次啟動要能**從斷點續跑**,
尤其**最耗額度的 `claude -p` 那一步不可白燒**。

核心原則(沿用既有):**不改動監聽/解密/寫 JSONL 邏輯**;三程序(bot / worker / dashboard)
只透過檔案系統解耦;dashboard 對佇列原本唯讀,本次**新增最小限度的驗收動作端點(僅 127.0.0.1)**。

---

## 已定案的決策

| 主題 | 決策 | 理由 |
|------|------|------|
| executor 機制 | **採用 bot_gui 的「runner 跑 skill + NDJSON 邊跑邊回報」契約**,改放進 element-bot 解耦底盤 | 契約已被 bot_gui spike 實測去風險;整個 stack(judge.js / bot_gui)都建在 `claude -p` CLI 上 |
| 不採 Agent SDK | 否決 in-process Claude Agent SDK | 換 SDK 只增依賴與風險,CLI 路徑已驗證,無實益 |
| 續跑粒度 | **步驟級檢查點**(state.json 記錄各步驟完成與否) | 簡單、穩;ai_run 再加「產物已存在且 verify 過則跳過」保護額度 |
| 安全網 | **隔離副本 + git 乾淨檢查 + verify 把關**,對齊 bot_gui | 第一個任務會改檔案,事後驗證不可省;正本零改動 |
| 範圍 | **A(真 executor)+ B(驗證台)一起做**,切成 5 個可獨立驗證的步驟 | 使用者要求一次拿到可驗證的閉環,且每步要能驗 |
| dashboard 動作 | 在唯讀底盤上**新增** POST 動作端點(驗收 / 重跑 / 開檔),綁 127.0.0.1 | 「在畫面上驗證」需要動作;維持機密不外流 |
| 新增 skill 成本 | **加一筆任務定義(prompt / verify 指令 / 產物路徑),不動 worker/bot/dashboard** | 框架做一次,之後只插 skill |

---

## 架構

```
bot (src/index.js) ──→ runTriggerPipeline ──→ enqueue ──→ queue/pending/<id>.json
                                                              │
worker (src/worker.js)                                        ▼
  pollOnce → processOne → agentExecutor(可中斷續跑)
    ├─ queue/work/<id>/         ← 隔離副本 + state.json 檢查點(續跑依據)
    ├─ queue/logs/<id>.log      ← NDJSON 進度(append;dashboard 來源)
    ├─ queue/processing/<id>.json   執行中(被中斷則成孤兒,啟動時回收)
    └─ queue/done/ 或 queue/failed/  終態

dashboard (src/dashboard/) ── 唯讀讀 logs/state/queue → 顯示逐步進度 + needsReview
                            └─ 新增動作端點(127.0.0.1):驗收 / 重跑 / 開檔
```

三程序維持只靠檔案系統溝通。

---

## 核心一:可中斷續跑的狀態機

### 工作區與檢查點

每個任務有獨立工作區 `queue/work/<id>/`,內含隔離副本與 `state.json`:

```json
{
  "id": "2026-06-29T...-i18n-abc",
  "steps": { "prepare": "ok", "ai_run": "pending", "verify": "pending", "summarize": "pending" },
  "workDir": "queue/work/<id>/copy",
  "attempt": 2,
  "updated_at": "2026-06-29T..."
}
```

- **步驟級跳過**:resume 時讀 `state.json`,狀態為 `ok` 的步驟直接跳過,從第一個非 `ok` 步驟續跑。
- **ai_run 的額度保護**:跑 `claude -p` 前先檢查「預期產物是否已存在」。
  - 已存在 → 跳過 claude,直接進 verify(避免重燒額度)。
  - 不存在 → 才跑 claude。claude 成功 exit 0 才把 `ai_run` 標 `ok`;中斷則維持 `pending`,下次重試。
- 每個步驟完成後**立即寫 `state.json`**(原子寫:先寫暫存再 rename),確保任何時點中斷都有正確斷點。

### worker 啟動回收(同時修現有 bug)

- 現況:任務搬到 `processing/` 後若程序崩潰,會**永遠卡在 `processing/`**(workerCore 已註明)。
- 新行為:**worker 啟動時做一次回收掃描**,把 `processing/` 內所有任務搬回 `pending/`。
  因為對應的 `queue/work/<id>/state.json` 仍在,該任務被重新撿起時會**從斷點續跑**而非從頭。
- `pollOnce` 維持只掃 `pending/`(避免重入);`processing/` 只代表「當前 live worker 正在跑」。

### 狀態語意

| 目錄 | 意義 |
|------|------|
| `pending/` | 待跑(全新,或被中斷待續 —— 由 `work/<id>/state.json` 是否存在決定) |
| `processing/` | live worker 正在跑;啟動回收會把殘留者搬回 `pending/` |
| `done/` | 成功終態(work/ 可保留供開檔驗收,或於驗收後清理) |
| `failed/` | 失敗終態(含 `<id>.json.error.txt`);可由 UI 重跑回 `pending/` 續跑 |

---

## 核心二:runner 契約(把 bot_gui 形式化)

executor 依**任務定義**驅動固定步驟,每步邊跑邊吐 NDJSON 到 `queue/logs/<id>.log`(append、印完即 flush):

1. **開場宣告步驟**:`{"steps":[{"key":"prepare","label":"準備隔離副本"}, ...]}`
2. **每步進度**:`{"step":"ai_run","status":"run|ok|stop|error","ms":420,"note":"..."}`
3. **最後一行總結(必出一次)**:`{"status":"OK","summary":"...","needsReview":["..."],"openPath":"..."}`

固定步驟:`prepare`(隔離副本 + git 乾淨檢查)→ `ai_run`(`claude -p` 跑 skill)→
`verify`(跑 verify 腳本)→ `summarize`(出總結)。

**總結頂層 status 語意**(對齊 bot_gui,dashboard 據此呈現):

| status | 意思 | 畫面行為 |
|--------|------|----------|
| `OK` | 成功、已產出 | 綠 + summary;needsReview 標 ⚠;有 openPath 可開檔 |
| `NEEDS` | 產出但 verify 有缺 | 標出缺什麼,待人處理 |
| `DUP` / `NOOP` | 沒做事(撞重/無須處理) | 中性,不算錯 |
| `ERROR` | 失敗 | 紅 + message |

**任務定義(每 skill 一筆,放 config)**:描述「怎麼隔離、claude prompt、verify 指令、預期產物路徑」。
新增 skill 只需加一筆定義(必要時一個小 adapter),**不動 worker / bot / dashboard / 佇列格式**。

第一個任務 = **防偵測 i18n**(會改檔案):隔離副本跑 `template-i18n-inject` skill,
`verify_i18n.py` 把關 errors=0,needsReview = 「人工核對文案、套正式站前再確認」。

---

## 核心三:監控台升級成驗證台

在現有 master-detail 監控台(`src/dashboard/`)**之上新增**,保留唯讀底盤與既有測試:

### 唯讀部分(讀 logs/state)
- **逐步進度**:解析 `logs/<id>.log` 的 NDJSON → 渲染 ⏳/✓/✗ + 秒數(移植 bot_gui `stepsHtml` 風格)。
- **needsReview 提醒**:總結的「要補什麼」標 ⚠(移植 bot_gui)。
- 現有「點任務看詳情 + 日誌」維持,日誌面板從占位符變成真實 NDJSON 渲染。

### 動作部分(新增 POST 端點,綁 127.0.0.1)
- `開啟產物`:用 OS 開啟總結的 `openPath`(後端 spawn 開檔;路徑須在 `queue/work/` 內,防穿越)。
- `✓ 驗收完成`:把任務標記驗收(寫一個 verified 標記;done/ 任務移入已驗收摺疊區)。
- `重跑`:`failed/<id>.json → pending/`;因 `work/<id>/state.json` 仍在,自動從斷點續跑。
- 所有動作端點:綁 `127.0.0.1`、對 id 做防穿越檢查、僅允許佇列內路徑。

---

## 各元件改動清單

| 檔案 | 新增/異動 | 說明 |
|------|-----------|------|
| `src/executors/agentExecutor.js` | 新增 | 取代 dryRun 當預設;step-level 檢查點、NDJSON、產物跳過、隔離副本、claude -p、verify |
| `src/executors/checkpoint.js` | 新增(純函式) | 讀/寫 state.json、決定下一個要跑的步驟、判定步驟跳過 |
| `src/taskDefs.js`(或 config) | 新增 | 每 skill 的任務定義(隔離方式 / prompt / verify 指令 / 產物路徑) |
| `src/workerCore.js` | 異動 | 啟動回收(processing→pending);processOne 串 agentExecutor 並支援續跑 |
| `src/worker.js` | 異動 | 啟動時跑一次回收掃描;預設 executor 換成 agentExecutor |
| `src/dashboard/aggregate.js` | 異動 | NDJSON log 解析成步驟陣列、總結解析、verified 標記 |
| `src/dashboard/server.js` | 異動 | 新增動作端點(驗收 / 重跑 / 開檔),維持防穿越與 127.0.0.1 |
| `src/dashboard/public/index.html` | 異動 | 渲染逐步進度、needsReview、驗收/重跑/開檔按鈕 |
| `config/rules.json` | 異動 | 第一個真實規則(防偵測 i18n),`task` 對到任務定義 |
| `test/` | 新增/異動 | checkpoint、回收、NDJSON 解析、動作端點、續跑流轉 等測試 |

**刻意不動**:`src/index.js` 監聽/解密、`normalize`/`handler`/`writer`、`judge`/`matcher`/`trigger`/`enqueue`、
`bot_gui` 任何檔案。

---

## 實作步驟切法(每步可獨立驗證)

| # | 步驟 | 完成後的驗證 |
|---|------|--------------|
| 1 | 佇列狀態機 + `state.json` 檢查點 + 啟動回收 | 單元測試:中斷後 processing→pending、已完成步驟跳過;手動殺 worker 再起,任務從斷點續 |
| 2 | agentExecutor 骨架 + NDJSON + 步驟跳過(先用 echo 假 skill) | 跑一條假任務,log 出現逐步 NDJSON;中途砍掉重跑,已完成步驟被跳過 |
| 3 | 真隔離副本 + `claude -p` 跑第一個改檔 skill + verify | 發觸發訊息 → work/ 出現副本與產物;**md5 比對正本零改動**;verify errors=0 |
| 4 | 監控台渲染逐步進度 + needsReview | 瀏覽器看到任務即時跑過 prepare→ai_run→verify;⚠ 提醒出現 |
| 5 | 監控台驗收動作(開檔 / 驗收 / 重跑) | 點「開啟產物」開檔;點「重跑」failed 任務從斷點續完成 |

跑完整鏈 = 「群裡發一句 → 自動隔離跑 skill → 畫面看進度 → 開檔驗收」。

---

## 錯誤處理 / 邊界

- **claude -p 中斷/逾時/非零 exit**:`ai_run` 維持 `pending`,任務移 `failed/`(可重跑續);不影響其他任務。
- **產物半成品**:`ai_run` 只在 claude exit 0 後標 `ok`;產物存在但 verify 不過 → status `NEEDS`,不誤判完成。
- **隔離副本 git 不乾淨 / 站不在 git**:`prepare` 失敗並回報原因(對齊 bot_gui in-place 安全檢查)。
- **state.json 損毀**:視為無檢查點 → 從頭重跑(安全保守)。
- **work/ 殘留**:done/ 任務的 work/ 可於驗收後清理;失敗者保留供排查。
- **動作端點**:id 防穿越、路徑須在佇列內、僅綁 127.0.0.1。

---

## 安全考量

- executor 跑 skill 會用 `claude --dangerously-skip-permissions`,故**一律在隔離副本內執行**,
  prompt 明令「只准讀寫當前工作目錄」;完成後對正本做 md5/git 比對確認零改動(對齊 bot_gui spike)。
- 輸出含解密公司訊息;dashboard 僅綁 `127.0.0.1`、無登入、不對外。
- `queue/`(含 work / logs)、`storage/`、`output/` 已在 `.gitignore`。

## 不在範圍(YAGNI / 未來)

- 並發 worker、任務逾時可調、分散式佇列。
- 第二個 skill(`anti-detect`)、左路本地建置/截圖、右路測試環境(屬大項目後續期)。
- 回寫 Matrix(雙向「反覆溝通」)屬**大項目二**,本 spec 不含。
- claude session `--resume` 續話(本版用步驟級檢查點 + 產物跳過已足;session 續話列為未來優化)。
