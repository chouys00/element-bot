# Dashboard 表格欄寬可拖動 — 設計

日期:2026-07-10
範圍:`src/dashboard/public/`(純前端,無後端改動)

## 問題

Dashboard 的表格欄寬是寫死的,資訊較多時被截斷:

- **觸發任務表**(index.html):CSS grid `grid-template-columns: 80px 13% 20% 1fr 72px`。狀態欄固定 72px,裝不下「LLM 判斷失敗 / LLM 判斷中 / LLM 不觸發」等 5 字標籤,超過 4 字就被 ellipsis 截斷。
- **規則清單表 / 試跑結果表**(rules.html):傳統 `<table>`,欄寬由內容自動撐開,長內容互相擠壓。

使用者要:欄寬可拖動、狀態欄置中、狀態欄最小寬加大,且三個表格一致處理。

## 目標

1. 三個表格皆可用滑鼠拖動表頭邊界調整欄寬。
2. 欄寬記憶到 `localStorage`,重開頁面仍在。
3. 觸發任務表狀態欄:內容置中、預設寬容得下 5 字不截斷。
4. 不影響 1.5s 輪詢效能。

## 效能關鍵:欄寬與輪詢解耦

輪詢每 1.5s 只重建 `<tbody>` innerHTML。欄寬不能存在被重建的 row 上,否則每次重繪被打回預設。

作法:欄寬存成**外層容器**上的狀態(grid 用容器 CSS 變數;table 用 `<colgroup>`),重建 tbody 時新 row 自動繼承,零額外成本。`localStorage` 只在「拖動放開」寫一次、「頁面載入」讀一次,輪詢期間完全不觸碰。

## 共用模組 `public/resizable.js`

兩頁各以 `<script src="/resizable.js"></script>` 載入,匯出全域:

```
makeResizable(table, { key, layout, mins })
```

- `key`:localStorage 鍵(每個表獨立)。
- `layout`:`"grid"`(觸發任務表,欄寬 = 容器 CSS 變數 `--rz-cols`)或 `"table"`(傳統表,欄寬 = 注入的 `<colgroup>`)。
- `mins`:各欄最小寬(px)陣列,拖動不得小於此。

### 欄寬模型:相鄰欄互償

拖動第 i 欄右邊界:delta 加到第 i 欄、從第 i+1 欄等量扣除,兩欄各受自身 `min` 限制。總寬守恒 → 表格永遠填滿容器,無橫向捲軸。

### 行為

- 表頭右緣一條拖動把手(hover 才明顯,平時低調),`th` 設 `position:relative`。
- 拖動即時更新容器欄寬狀態(CSS 變數 / colgroup),放開時把欄寬陣列寫入 localStorage。
- **雙擊把手** = 清掉該表 localStorage、還原響應式預設。
- 初始:有 localStorage 才鎖 px;**沒有記憶時不鎖 px**,保留 HTML/CSS 原本的響應式欄寬(grid 的 %/fr、table 的 auto)。使用者真的拖動的當下才量測目前實際欄寬為起點——避免載入時機/面板寬度影響量到坍縮值。
- 互償兜底:相鄰兩欄總寬小於兩欄 min 之和(容器過窄)時夾回各自 min,絕不讓欄寬變負。
- 動態重建表格(如試跑結果表)後重新套用容器欄寬狀態。

## 各表套用

| 表 | 檔案 | layout | 備註 |
|---|---|---|---|
| 觸發任務 | index.html | grid | 狀態欄置中 + 最小寬加大到 5 字不截斷 |
| 規則清單 | rules.html | table | 7 欄,改 `table-layout: fixed` |
| 試跑結果 | rules.html | table | 動態重建,重建後重套欄寬 |

## 非目標(YAGNI)

- 不做欄位順序拖動、不做隱藏欄、不做排序。
- 開發用「監聽訊息」表(將移除)不處理。
