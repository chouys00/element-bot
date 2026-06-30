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

- [ ] **S1. 後端純函式**
  - `taskDefs.js`:加 `taskNames()` 回 `Object.keys(DEFS)`,export 出去(供 task 下拉)
  - `rules.js`:加 `saveRules(path, rules)` = 全條 `validateRule` 通過才**原子寫**(寫 `.tmp` 再 rename)
  - 測試:saveRules 全過才寫 / 有壞規則整批拒不寫 / 寫入內容正確;taskNames 含 demo-skill
- [ ] **S2. config**
  - `loadDashboardConfig` 補 `rulesPath`(目前只有 loadConfig 有)
- [ ] **S3. server endpoints**
  - `GET /api/rules` → `{ rules, rooms, tasks }`(規則 + 房間 id→名 + task 名單)
  - `PUT /api/rules` → body 整個陣列;驗證後 saveRules;非法回 400 不寫檔
  - 測試:GET 讀回正確 / PUT 合法寫入 / PUT 非法回 400 且檔案不變
- [ ] **S4. 前端新分頁**
  - `public/rules.html` + `public/rules.js`;index.html 互加導航連結
  - 規則列表 + 新增/編輯/刪除 + 儲存全部
  - 表單:name / keywords(逗號分隔)/ task(下拉)/ rooms(多選房名→存 id)/ use_llm(勾)/ intent+extract(use_llm 時顯示)
- [ ] **S5. 熱載入**
  - 新模組 `rulesWatcher.js`:`watch(rulesPath, onReload)` 含 debounce;reload 邏輯抽成可測函式
  - `index.js`:rules 改可變持有者;watch 成功 swap、失敗保留舊規則 + log
  - 測試:reload 判斷邏輯(壞檔保留舊、好檔換新)
- [ ] **S6. 端到端手動驗證**
  - 重啟三件套 → UI 新增帶 rooms 的規則 → 存檔 → 確認 bot log 顯示「已重載」→ 發訊息驗證房間範圍(補做之前緩驗的部分)

---

## RESUME HERE

**目前進度:尚未開始 S1。** 下一步:建立 task 清單,開始 S1(taskDefs.taskNames + rules.saveRules + 測試)。

## 注意事項 / 雷

- Windows 上 `fs.watch` 一次變動常觸發多次 → 必須 debounce
- 編輯器/原子寫過程中 bot 可能短暫讀到舊或寫一半的檔 → saveRules 用 tmp+rename;watcher reload 失敗時保留舊規則
- dashboard 與 bot 是**獨立進程**,只靠 rules.json 溝通,無 IPC
- 測試指令:`npm test`(目前 206 項,新增測試要併進 package.json 的 test script)
- dashboard 只綁 127.0.0.1;rulesPath 來自 config 固定值,非使用者輸入
