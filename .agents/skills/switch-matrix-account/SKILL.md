---
name: switch-matrix-account
description: 把 element-bot 監聽的 Matrix 帳號從一個換成另一個(例如個人測試帳號換成公帳)。使用者說「換帳號」「切換成公帳」「switch account」時使用。逐步檢查/更新 .env 三個值、清掉舊帳號殘留的本地狀態、驗證新帳號能登入且看得到監聽房間。
---

# 切換 element-bot 的 Matrix 帳號

把 bot 監聽用的帳號換成另一個(常見情境:個人測試帳號 → 團隊公帳)。

**核心觀念:換帳號不是只改一個 user id。三樣東西必須是「同一個新帳號」的、且新帳號本身要先具備條件、還要清掉舊帳號綁定的本地游標。任何一項漏掉,bot 會登入成功卻解不開訊息或收不到訊息。**

## 0. 機密紅線(先讀)

- `MATRIX_PASSWORD`、`MATRIX_RECOVERY_KEY` 是高機密。**絕不要請使用者把密碼或 recovery key 貼到對話裡**(對話紀錄會留存)。請他自己用編輯器改 `.env`,你只檢查「欄位有沒有值」,不讀、不印、不寫進任何日誌的實際內容。

## 1. 先確認新帳號本身的前置條件(在 Element 裡,不是這支程式能代勞的)

引導使用者逐項確認,缺哪項就停下來請他先去補:

1. **新帳號已開好 Secure Backup / 跨簽章**,伺服器上有 key backup、且手上有對應的 recovery key。
   - 為什麼:bot 是「用 recovery key 還原既有 backup 來建立信任」(見 `src/matrixClient.js` 的 `decodeRecoveryKey`、`src/trust.js`)。全新、從沒設過 Secure Backup 的帳號沒有 backup 可還原,信任流程走不通。
2. **新帳號已被邀請並加入所有要監聽的房間**。
   - 正式監聽清單以 dashboard「🏠 監聽房間」為準(存於 `storage/rooms-config.json`)。讀該檔列出目前房間 ID 給使用者核對——若裡面還是舊的測試房間,請他一併在 dashboard 更新成正式房間。新帳號沒加入某房 → 收不到該房訊息。

## 2. 停掉正在跑的 bot

- 換帳號前必須先停 bot,否則舊 session 還連著、且改 `.env` 不會即時生效。
- 找到並停掉 bot 程序(`npm start` / `src/index.js` 那支)。停完可順手清 `storage/bot.lock`(殘留鎖檔)。
- worker、dashboard 不需要停(它們不碰 Matrix 帳號)。

## 3. 更新 .env 的三個值(必須全是「新帳號」的)

請使用者自己編輯 `.env`,同時改這三項——**最常見的錯是只改前兩項、忘了換 recovery key**:

| 變數 | 換成 |
|------|------|
| `MATRIX_USER_ID` | 新帳號的完整 id 或 localpart |
| `MATRIX_PASSWORD` | 新帳號密碼 |
| `MATRIX_RECOVERY_KEY` | **新帳號自己的** recovery key(不能沿用舊帳號那把) |

改完後你只驗證三個欄位「都有值」(遮蔽輸出,例如 grep 後把 `=` 之後改成 `<省略>`),不檢查內容正確性。

## 4. 清掉舊帳號綁定的本地殘留

換帳號時這些是舊帳號的狀態,不清會出錯或抓錯起點:

- **`storage/bot.json`** — 內含 `syncToken`,是舊帳號的同步游標。**刪掉**,讓新帳號從頭 sync。
- **`storage/crypto/`** 底下的 `*.sqlite3*` — 舊架構殘檔(現在 crypto 是純記憶體 `useIndexedDB:false`,不再落地),一併刪掉當清理。

不要動:`rooms-config.json`(監聽清單,與帳號無關,要保留)、`notify-config.json`(通知設定)。

## 5. 啟動並驗證(全過才算切換成功)

1. `npm start`,看日誌:
   - `已登入 @<新帳號>...`(確認登入的是新帳號,不是舊的)
   - 出現「用 recovery key 建立裝置信任 + 還原 key backup」且**沒有反覆報錯**(首次登入 + 還原可能要一兩分鐘)
2. dashboard 頂部顯示「🟢 bot 連線中」。
3. 請使用者在**其中一個監聽房間**發一則測試訊息 → 確認 bot 有解密收到(看 `output/messages.jsonl` 尾端或 dashboard 訊息區出現該則)。
   - 收不到 → 多半是新帳號沒加進該房(回第 1.2 步),或 recovery key 不是新帳號的(信任沒建立,訊息解不開)。

## 6. 回報

整理成清單:登入帳號是否正確、信任是否建立、三個監聽房間各自能否收到訊息、清了哪些檔。有未過項就給具體下一步。

## 常見失敗對照(回報時可帶上)

- **登入成功但訊息全是亂碼/解不開** → recovery key 還是舊帳號那把,或新帳號沒設 Secure Backup。
- **完全收不到某房訊息** → 新帳號沒被邀進那個房間。
- **sync 一直報錯 / 卡住** → `storage/bot.json` 的舊 syncToken 沒清。
- **啟動報「偵測到另一個 element-bot 實例」** → 舊 bot 沒停乾淨或 `storage/bot.lock` 殘留。
