---
name: restart-element-bot
description: Use when working in element-bot and the user says「啟動」、「啟動專案」、「重啟」、「重新啟動」or “restart”; not for「檢查狀態」or new-machine setup/deployment.
---

# 重啟 element-bot

## 核心契約

「啟動」與「重啟」具有相同語意：安全閘門通過後，停止本 repository 的舊程序，再啟動磁碟上的目前版本。即使服務已在執行也要重啟。

「檢查狀態」只做唯讀檢查。若使用者說「建置環境」、「部署到這台」、「setup」或「完整驗證」，改用 `setup-deploy-env`。

## 安全閘門

1. 確認工作目錄是 element-bot repository；確認 Node、`node_modules`、`.env` 存在。缺少時停止並引導使用 `setup-deploy-env`，不得自行跑安裝或完整部署。
2. 讀 `.env` 的 `DASHBOARD_HOST`、`DASHBOARD_PORT`，不要輸出任何機密值；不得猜測預設 port 3000。
3. 查 `/api/status`，並直接計數：
   - `queue/judging/*.json` → `judging`
   - `queue/processing/*.json` → `processing`
   - `queue/approvals/pending/*.json` 加 `queue/approvals/processing/*.json` → `publishing`
4. 任一活動數量大於零時，列出數量與可取得的任務 ID，停止並要求使用者做操作當下確認；先前說過「強制」也不能取代這次確認。
5. 只接受同時符合 repository 絕對路徑及 entry point 的 PID：
   - bot：`src/index.js`
   - worker：`src/worker.js`
   - dashboard：`src/dashboard/index.js`

可交叉使用 `storage/bot.lock` 與 dashboard port owner，但 PID 或 command line 無法驗證時不得終止。不得廣泛終止所有 `node.exe`。Windows 只對已驗證 PID 執行 `taskkill /PID <pid> /T /F`。

## 快速重啟

不得執行 `npm run test:codex-smoke`、`npm install` 或完整測試。

若任何 shell 指令回報 `CreateProcessAsUserW failed: 5` 或 process creation「存取被拒」，立即改用 host 主機的提升權限 shell；不得重試相同 sandbox。

Windows 的持續背景程序使用 `Start-Process` 搭配 `-WindowStyle Hidden`，並設定 repository `WorkingDirectory`。不得使用 `-PassThru`；沒有獨立隱藏視窗或保留 process handle，都可能讓此主機在約五分鐘後回收背景程序。`ArgumentList` 必須使用 entry point 的絕對路徑，讓 command line 保留 repository 身分供下次精確比對；不要只傳相對的 `src/...`。

Windows PowerShell 5.1 做不分大小寫比對時使用 `IndexOf`，不得使用不支援的 `String.Contains(value, StringComparison)` overload。組合 cmdlet 與布林條件時要把 `Test-Path` 呼叫括住，再接 `-and`，避免 `-and` 被誤當成 cmdlet 參數。

把 stdout/stderr 分別導到：

- `bot.log` / `bot-err.log`
- `worker.log` / `worker-err.log`
- `dashboard.log` / `dashboard-err.log`

合併啟動遭拒或已進入提升權限路徑時，固定用四次獨立呼叫，依序：

1. 保留並輪替舊 log（附時間戳，不覆寫）。
2. 啟動 bot：`src/index.js`。
3. 啟動 worker：`src/worker.js`。
4. 啟動 dashboard：`src/dashboard/index.js`。

不得把 WMI 當作啟動 fallback；不得把排程工作當作啟動 fallback；不得把 computer-use 當作啟動 fallback。`Start-Process` 成功但空輸出不代表失敗，也不代表成功，直接進入條件驗證。

## 條件式輪詢與完成條件

條件式輪詢最多 120 秒，不用固定長時間等待。全部成立才回報成功：

- `.env` 實際 port 的 `/api/status` 回傳 HTTP 200。
- `bot_online` 為 `true`，heartbeat 年齡不超過 90 秒。
- bot、worker、dashboard 各有一個符合路徑與 entry point 的存活 PID。
- error logs 沒有新的 fatal 啟動錯誤；stderr 非零不代表啟動失敗，Matrix E2EE 等待金鑰的警告可接受，但必須同時確認 key backup 後持續 Matrix sync HTTP 200。
- `DASHBOARD_HOST=0.0.0.0` 時，實際區網 IPv4 URL 回傳 HTTP 200。

最後回報三個 PID、實際 dashboard URL、各項驗證結果與殘留風險。失敗時保留程序與 log 證據，指出停在哪個條件；不要改跑 Codex smoke。
