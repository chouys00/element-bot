---
name: setup-deploy-env
description: 在新機器(公用電腦)上從 clone 到跑起來的環境建置與驗證。使用者說「建置環境」「部署到這台」「setup」時使用。逐項檢查 Node/Codex CLI/.env/目標專案/防火牆,啟動 bot+worker+dashboard 並驗證同事可跨機器訪問。
---

# element-bot 新機器環境建置

把剛 clone 下來的 element-bot 在這台機器上跑起來:監聽 Matrix 訊息、命中規則派工到本機目標專案、dashboard 開放給區網內同事訪問。

**設計原則:每一步先檢查再動作(可重複執行);缺什麼就明確告訴使用者,不要猜。**

## 0. 機密紅線(先讀)

- `MATRIX_PASSWORD`、`MATRIX_RECOVERY_KEY` 是高機密。**絕不要請使用者把密碼貼到對話裡**(對話紀錄會留存)。一律請使用者自己用編輯器打開 `.env` 填入,填完回來說一聲即可。
- 你只能檢查 `.env` 的欄位「有沒有值」,不要把值印出來或寫進任何日誌/輸出。

## 1. 環境檢查

逐項執行並回報 ✅/❌:

1. **Node ≥ 22**:`node --version`。不足則請使用者安裝(mac 建議官方安裝包或 nvm;Windows 官方安裝包)。
2. **Codex CLI 已登入且 headless 可用**：`codex --ask-for-approval never exec --ephemeral --sandbox read-only "回覆 ok 兩字即可"`（允許數十秒）。失敗多半是未安裝或未登入 → 請使用者在終端跑 `codex login` 完成登入後重試。judge/probe/任務執行全靠它，這步不過後面免談。
3. **依賴已裝**:`node_modules` 不存在或 `npm ls matrix-js-sdk` 報錯就跑 `npm install`。

## 2. 設定 .env

1. `.env` 不存在 → `cp .env.example .env`。
2. 檢查必填欄位是否有值(只看有無,不看內容):`MATRIX_HOMESERVER`、`MATRIX_USER_ID`、`MATRIX_PASSWORD`、`MATRIX_RECOVERY_KEY`。缺的列給使用者,請他自行編輯 `.env` 填入(見機密紅線)。
3. **帳號衝突提醒**:bot 啟動會以新裝置登入並清掉同名舊裝置。若原本那台電腦還會跑 bot,這台**必須用不同的 Matrix 帳號**,否則互踢且同一訊息會被兩邊各觸發一次。請使用者確認這台用的帳號,以及該帳號已被邀進要監聽的房間。
4. 要讓同事跨機器訪問 dashboard:確認 `.env` 有 `DASHBOARD_HOST=0.0.0.0`(預設僅 127.0.0.1,同事會連不進來)。`DASHBOARD_PORT` 預設 3000。
5. **監聽房間要重設**:全新機器沒有 `storage/rooms-config.json`,系統會落到 `.env` 的 `MATRIX_ROOM_IDS` 後備值——那多半是別台帶來的舊測試房間,**不要沿用**。正式監聽的房間清單一律在 dashboard 起來後到「🏠 監聽房間」重新設定(見第 5、6 步),並確認 bot 帳號已加入這些房間。`.env` 的 `MATRIX_ROOM_IDS` 可留空或忽略。

## 3. 準備目標專案(派工對象)

0. **`config/rules.json` 不入版控**(隨機器而異),全新 clone 不會有這個檔。要嘛 `cp config/rules.example.json config/rules.json` 當起點,要嘛直接讓 dashboard 起來後在「⚙ 規則設定」新增(存檔即建檔)。bot 在缺檔時會以「無規則」啟動,不會 crash。
1. 讀 `config/rules.json`(若已建立),列出所有啟用規則的 `project_path`。
2. 逐一檢查:路徑存在?是 git 倉庫?工作區乾淨?(executor 的 prepare 會擋不乾淨的專案)
3. 路徑不存在的(多半是從別台機器帶過來的舊路徑,例如 Windows 的 `D:\...` 在 mac 上必然失效):問使用者對應專案在這台機器的實際位置,沒 clone 的請他先 clone,然後**直接更新 rules.json 裡的 project_path**(或請他到 dashboard「⚙ 規則設定」改)。
4. 不檢查、不搬移目標專案的 instructions 或 skill 體系；element-bot 只負責把 command 分派到該專案，由 Codex依目標專案自身設定決定流程。

## 4. 網路放行

- **macOS**:防火牆預設多半關閉。若開著,第一次啟動 dashboard 時系統會跳「允許 node 接受連入連線?」→ 請使用者按允許;或到系統設定 → 網路 → 防火牆放行 node。
- **Windows**(以系統管理員 PowerShell):
  `New-NetFirewallRule -DisplayName "element-bot dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow`
- 查本機區網 IP(mac:`ipconfig getifaddr en0`;Windows:`ipconfig`),記下來,這是同事要用的位址。
- 提醒使用者:IP 若是 DHCP 動態配發,換 IP 大家連結就失效,建議請 IT 給固定 IP 或 DHCP 保留。

## 5. 啟動三個程序

先確認沒有殘留實例(`storage/bot.lock` + 存活檢查由程式自理,若啟動報「偵測到另一個實例」再處理)。背景啟動並把輸出導到日誌:

```bash
# macOS / Linux
nohup npm start      > bot.log       2> bot-err.log       &
nohup npm run worker > worker.log    2> worker-err.log    &
nohup npm run dashboard > dashboard.log 2> dashboard-err.log &
```

Windows 用 `Start-Process node -ArgumentList "src/index.js" -WorkingDirectory <專案絕對路徑> -RedirectStandardOutput bot.log -RedirectStandardError bot-err.log`(三個程序各一條,worker 為 `src/worker.js`、dashboard 為 `src/dashboard/index.js`)。

啟動後看日誌確認:
- `dashboard.log` 出現 `監控台已啟動 → http://0.0.0.0:3000`
- `bot.log` 完成登入與同步、無反覆報錯(首次登入 + key backup 還原可能要一兩分鐘)

## 6. 驗證(全過才算完成)

1. `curl -s http://127.0.0.1:3000/api/status` → `bot_online: true`。
2. `curl -s http://<區網IP>:3000/` 從區網位址打得通(驗證沒有只綁 localhost)。
3. **設定正式監聽房間**:到 dashboard「🏠 監聽房間」填入這台要監聽的房間 ID(不要用舊測試房),存檔會熱載入免重啟;確認 bot 帳號已加入這些房間。
4. 請使用者在其中一個監聽房間發一則會命中規則的測試訊息 → dashboard 任務清單出現該任務並跑完。
5. 請使用者用**另一台電腦**的瀏覽器開 `http://<區網IP>:3000` 確認看得到監控台。

最後把結果整理成清單回報:每步 ✅/❌、同事訪問用的網址、以及未完成項的具體下一步。

## 已知取捨(回報時要提)

dashboard 的 `/api/*` 目前沒有任何身份驗證,綁 `0.0.0.0` 後同網段任何人都能看訊息、改規則、觸發任務。這是使用者已知並決定先跑通再處理的事項——回報時提醒一句即可,不要擅自加驗證機制。
