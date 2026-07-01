# 🟡 規則編輯 UI(rule-editor-ui)實作計畫 / 交接文件

分支:`feat/rule-editor-ui`(基於 `feat/rule-room-scoping`,已含 rooms 欄位 + 純 ID 比對)

> **這份檔的用途**:可能撞 token 上限被中斷。任何時候接手 = 讀這份檔的「目前進度」+ `git log --oneline` 即可續做。每完成一個步驟就更新本檔的勾選與「RESUME HERE」標記並 commit。

---

## 目標

在 dashboard 加一個「規則編輯」分頁,讓操作者用 UI 管理 `config/rules.json`,免手改 JSON。
bot 端用 `fs.watch` 熱載入,存檔即生效、免重啟。

## 已拍板的決策

- 熱載入:`fs.watch`(UI 存檔即生效)
- UI 位置:**新分頁** `rules.html`(不擠首頁)
- 寫入策略:**整批取代**(前端記憶體增刪改 → 按「儲存」整批 PUT;rules.json 小、單一管理者、本機工具)
- 前端:**零依賴純 HTML/JS**,沿用現有 index.html 風格
- rooms 欄位:UI 多選顯示房名、值存 **room_id**;空 = 全部房間

## 資料流

```
[Dashboard 進程]                    [Bot 進程]
規則編輯 UI                          fs.watch(rules.json)
   │ PUT /api/rules                     │ 偵測變動(debounce)
   ▼                                    ▼
驗證每條 → 原子寫 rules.json ──────→ 重讀 + loadRules 驗證
                                        成功:swap 記憶體規則
                                        失敗:保留舊規則 + 警告(不崩)
```

---

## 建構清單(TDD,每步做完即 commit)

- [x] **S1. 後端純函式** ✅
  - `taskDefs.js`:加 `taskNames()` 回 `Object.keys(DEFS)`,export 出去(供 task 下拉)
  - `rules.js`:加 `saveRules(path, rules)` = 全條 `validateRule` 通過才**原子寫**(寫 `.tmp` 再 rename)
  - 測試:rules 21 項、taskDefs 17 項通過
- [x] **S2. config** ✅
  - `loadDashboardConfig` 補 `rulesPath`(目前只有 loadConfig 有)
- [x] **S3. server endpoints** ✅
  - `GET /api/rules` → `{ rules, rooms, tasks }`(規則 + 房間 id→名 + task 名單)
  - `PUT /api/rules` → body 整個陣列;驗證後 saveRules;非法回 400 不寫檔
  - 測試:dashboardServer 29 項通過(含 GET/PUT 合法/非法/壞 JSON)
- [x] **S4. 前端新分頁** ✅
  - `public/rules.html`(JS 內嵌,與 index.html 同單檔風格,未拆 rules.js);index.html 頁首加「⚙ 規則設定」連結、rules.html 加「← 回監控台」
  - 規則列表 + 新增/編輯/刪除 + 儲存全部(整批 PUT)
  - 表單:name / keywords(逗號分隔)/ task(下拉)/ rooms(多選房名→存 id,不選=全部)/ use_llm(勾)/ intent+extract(use_llm 時顯示)
  - 已用 curl 驗證 GET /api/rules 對真實檔正常、/rules.html 回 200(PUT 不動真實檔,留 S6 瀏覽器驗)
- [x] **S5. 熱載入** ✅
  - 新模組 `src/rulesWatcher.js`:`watchRules`(watch 目錄+檔名過濾+debounce,撐過 tmp+rename)、`reloadRules`(成功回新/失敗回舊)
  - `index.js`:接 watchRules,onChange 時 `rules = reloadRules(...)`(rules 是 let,閉包即時生效)
  - 測試:`rulesWatcher.test.js` 6 項(好檔換新/壞檔保留舊/非法保留舊/watch 偵測變動);全套 230 項通過
- [ ] **S6. 端到端手動驗證**
  - 重啟三件套 → UI 新增帶 rooms 的規則 → 存檔 → 確認 bot log 顯示「已重載」→ 發訊息驗證房間範圍(補做之前緩驗的部分)

---

## RESUME HERE

**目前進度:S1–S5 全部完成並 commit。全套 230 項通過。** 程式碼部分(後端+前端+熱載入)已全做完。
剩 **S6:端到端手動驗證**(需使用者操作瀏覽器 + Element 發訊息):
1. 重啟三件套(bot 要重啟才會載入 index.js 的 watcher;dashboard 已是新碼但保險起見一起重啟)
2. 瀏覽器開 http://127.0.0.1:3000 →「⚙ 規則設定」→ 新增一條帶 rooms 的規則(用下拉選實際房間)→ 儲存
3. 確認 bot log 出現「已熱載入 N 條規則」(免重啟生效)
4. 去 Element 對「有設 rooms」與「沒設 rooms」的房間分別發關鍵字訊息,驗證房間範圍過濾正確(補做之前緩驗的房間範圍)
完成後即可開 PR(這條分支基於 feat/rule-room-scoping;注意 PR base 與分支鏈)。

## 注意事項 / 雷

- Windows 上 `fs.watch` 一次變動常觸發多次 → 必須 debounce
- 編輯器/原子寫過程中 bot 可能短暫讀到舊或寫一半的檔 → saveRules 用 tmp+rename;watcher reload 失敗時保留舊規則
- dashboard 與 bot 是**獨立進程**,只靠 rules.json 溝通,無 IPC
- 測試指令:`npm test`(目前 206 項,新增測試要併進 package.json 的 test script)
- dashboard 只綁 127.0.0.1;rulesPath 來自 config 固定值,非使用者輸入
