# element-bot 快速啟動／重啟技能設計

**日期：** 2026-07-24
**狀態：** 待文件審閱

## 背景

目前 `setup-deploy-env` 面向新機器部署，會檢查 Node、Codex CLI、依賴、`.env`、目標專案並執行真實 Codex smoke test。這對首次建置必要，但不適合日常在修改程式碼後要求「啟動專案」；完整 smoke test 可能耗時數分鐘，且不是每次重載程式碼都需要。

本機開發情境的真正意圖是：**確保磁碟上目前版本已由 bot、worker、dashboard 三個程序重新載入並正常提供服務。**

## 已選方案

`啟動`與`重啟`採相同行為，兩者都是「安全地重新執行目前版本」的自然語言別名。

不採用自動偵測程式碼變更後才決定是否重啟，原因是 Git commit 無法涵蓋未提交檔案、`.env`、依賴與本機設定；增加狀態指紋仍可能誤判。

| 使用者指令 | 行為 |
| --- | --- |
| `啟動`、`啟動專案`、`重啟`、`重新啟動`、`restart` | 通過安全閘門後停止本專案三個程序，重新啟動並驗證 |
| `檢查狀態`、`服務狀態` | 唯讀檢查，不停止或啟動程序 |
| `建置環境`、`部署到這台`、`setup`、`完整驗證` | 維持使用 `setup-deploy-env`，包含真實 Codex smoke test |

## 實作邊界

新增一個名為 `restart-element-bot` 的 project skill。此技能只負責本 repository 的日常啟動與重啟，不修改 bot、worker、dashboard 的產品程式碼，也不接觸規則指向的目標專案。

技能必須明確排除完整環境建置；若缺少 Node、依賴或 `.env`，只回報缺失並引導使用 `setup-deploy-env`，不得在快速路徑中自行展開完整部署。

## 執行流程

### 1. 讀取非機密執行設定

- 確認工作目錄是 element-bot repository。
- 只檢查 `.env` 是否存在，以及 `DASHBOARD_HOST`、`DASHBOARD_PORT` 是否有值。
- 不輸出 `MATRIX_PASSWORD`、`MATRIX_RECOVERY_KEY` 或其他 Matrix 機密。
- 從 `.env` 取得實際 dashboard port，不假設是 3000。

### 2. 活動任務安全閘門

優先呼叫現有 dashboard `/api/status`；若 dashboard 不可用，改從 queue 目錄判斷。

下列任一數量大於零即視為有活動任務：

- `judging`
- `processing`
- `publishing`

有活動任務時不得自動停止程序。回報各狀態數量與可取得的任務 ID，並請使用者決定等待或明確強制中斷；取得使用者當下確認前不得終止。即使原始指令是「啟動」、「重啟」或「強制重啟」，也不能把它解讀為預先允許破壞尚未發現的執行中任務。

`pending` 任務已持久化，可在重啟後繼續處理，不阻擋重啟。

### 3. 精確識別程序

只能停止同時符合「本 repository 絕對路徑」與下列 entry point 的程序：

- bot：`src/index.js`
- worker：`src/worker.js`
- dashboard：`src/dashboard/index.js`

bot 可先讀取 `storage/bot.lock` 的 PID，但仍須驗證該 PID 的 command line。dashboard 可用實際 port 的 owning PID 輔助定位，但也必須驗證 command line。不得廣泛停止所有 `node.exe`，也不得只因 PID 存在就終止。

若 PID 或 command line 無法唯一確認，停止操作並回報，不猜測、不擴大終止範圍。

### 4. 停止與重新啟動

- 對已確認的三個程序執行 `taskkill /PID <pid> /T /F`；PID 必須來自前一步的精確識別。完整終止 Windows process tree，避免 worker 留下 Codex 子程序繼續修改目標專案。
- 等待舊 PID 全部退出後才啟動新程序。
- 若原本沒有任何服務程序，直接啟動三個程序，不把「無舊 PID」視為錯誤。
- 保存舊日誌，以時間戳重新命名，不直接刪除。
- Windows 使用隱藏背景程序啟動：
  - `node src/index.js`
  - `node src/worker.js`
  - `node src/dashboard/index.js`
- stdout/stderr 分別寫入既有標準日誌：
  - `bot.log` / `bot-err.log`
  - `worker.log` / `worker-err.log`
  - `dashboard.log` / `dashboard-err.log`

### 5. 條件式驗證

不得用固定長時間 sleep。啟動後輪詢，最長等待 120 秒：

1. dashboard 首頁回 HTTP 200。
2. `/api/status` 回 HTTP 200。
3. `bot_online` 為 `true`。
4. heartbeat 不超過 90 秒。
5. worker 程序仍存活，`worker-err.log` 沒有啟動失敗。
6. dashboard 綁定 `.env` 指定的 host 與 port。
7. 若可取得區網 IPv4，再以 `http://<區網IP>:<port>/` 驗證 HTTP 200。

驗證成功後回報本機與區網網址、新 PID、啟動耗時，以及是否載入監聽房間設定。不得執行真實 Codex smoke test。

## 錯誤處理

- dashboard 原本未運行時，活動任務安全閘門改讀 queue；不能因 API 不可用就直接假設安全。
- 停止部分成功時，重新掃描所有三個程序後再決定下一步，避免重複啟動。
- 任一新程序提前退出時，保留其他程序與日誌，明確回報失敗程序、exit 狀態與錯誤日誌尾端；不得宣稱整體啟動成功。
- bot 首次登入或 key backup 還原可能較慢，120 秒內持續使用 heartbeat／API 狀態判斷，不以單一日誌字串過早判定失敗。
- 歷史訊息的 E2EE 解密警告與新訊息同步失敗要分開回報；歷史警告不應單獨使啟動失敗。

## 測試與驗收

技能需先以沒有新技能的基準情境驗證既有失敗，再以相同情境驗證新技能：

1. 服務已運行且工作區有未提交修改，使用者說「啟動」：必須產生新 PID，不得只回報已在線。
2. `processing > 0` 時說「啟動」：不得終止程序，必須回報安全閘門。
3. 說「檢查狀態」：不得改變任何 PID。
4. dashboard port 不是 3000：必須使用 `.env` 的實際值。
5. 系統存在其他 Node 程序：不得停止不屬於本 repository 的程序。
6. dashboard/API 成功但 worker 已退出：不得宣稱三個服務全部成功。
7. 快速啟動流程：不得執行 `npm run test:codex-smoke`。

完成標準：

- `啟動`與`重啟`均穩定套用目前程式碼。
- 活動任務不會被未確認的重啟中斷。
- 非本專案 Node 程序不受影響。
- 成功回報必須有即時 API、heartbeat 與程序存活證據。
- 完整部署流程與快速啟動流程不再混用。

## 不在本次範圍

- 不新增 dashboard 身份驗證。
- 不建立 Windows Service、排程工作或開機自動啟動。
- 不修改 Matrix 帳號、房間或規則設定。
- 不自動安裝依賴或執行完整測試套件。
