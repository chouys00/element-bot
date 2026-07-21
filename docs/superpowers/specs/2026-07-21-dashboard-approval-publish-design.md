# Dashboard 驗收後通知專案發布設計

## 目標

Dashboard 的「驗收」是每項任務唯一一次人工核准。核准後由 element-bot 通知目標專案的 Codex／SKILL；目標專案自行執行 commit 與 push，element-bot 不呼叫 Git。

## 決策

- 不建置登入系統。瀏覽器第一次使用時保存驗收人姓名於 `localStorage`，驗收時自動送出；此姓名是可信內網署名，不具防偽能力。
- `target_branch` 設於 Dashboard 規則，經 trigger 原樣帶入任務。驗收 request 不得自行指定分支。
- 採獨立 approval outbox，不讓 Dashboard HTTP request 長時間執行 Codex，也不把核准工作混入一般任務清單。
- 同一 `task_id` 只能建立一筆核准事件。重複 request 回傳既有狀態，不再次通知。

考慮過但不採用：

1. 把核准通知當成一般 pending task：可重用 worker，但會產生第二個任務 ID、污染 Dashboard 任務清單。
2. Dashboard 直接呼叫 Codex：實作較短，但 HTTP timeout、程序重啟與職責邊界都較差。

## 資料結構

核准事件以原始完整任務 ID 為檔名，依狀態存於：

```text
queue/approvals/pending/<task_id>.json
queue/approvals/processing/<task_id>.json
queue/approvals/done/<task_id>.json
queue/approvals/failed/<task_id>.json
```

必要欄位：

```json
{
  "task_id": "原始完整任務 ID",
  "project_path": "目標專案絕對路徑",
  "target_branch": "目標分支",
  "approved_by": "Dashboard 保存的姓名",
  "approved_at": "伺服器產生的 ISO 8601 時間",
  "attempt": 0
}
```

`approved_by` 是 request 唯一接受的核准資料；`task_id` 取 URL、`project_path` 與 `target_branch` 取既有 done 任務、`approved_at` 由伺服器產生。

## 流程

1. 規則保存必填 `target_branch`，trigger 將其帶入一般任務。
2. 目標專案完成初始工作，任務進入 `done`，Dashboard 顯示待驗收。
3. 使用者按「驗收」。若瀏覽器尚無姓名，先設定並保存；之後每項任務只需按一次。
4. `POST /api/tasks/:id/approve` 驗證：安全 ID、任務位於 `done`、型別是 `skill-dispatch`、具備 `project_path` 與 `target_branch`、姓名合法。
5. Server 以排他建立方式寫入 approval pending event；既有事件不覆寫。
6. Worker 搬移事件到 processing，透過既有 `src/codexRunner.js` 在 `project_path` 執行 Codex。
7. Prompt 通知專案依自身 AGENTS.md、instructions 與 skills 執行核准後流程，包含四個核准欄位，要求 commit、push 到 `target_branch`，且 commit message 加入：

   ```text
   Task-ID: <task_id>
   Approved-by: <approved_by>
   ```

8. 專案 SKILL 必須以 `Task-ID` 檢查是否已完成，讓 worker 崩潰後重送仍具冪等性。
9. 成功事件移至 done；失敗自動重試至上限後移至 failed。不得要求第二次人工核准。
10. Dashboard 顯示待驗收、提交中、已發布或發布失敗，以及核准人與時間。

## 錯誤與邊界

- 缺少姓名、分支、專案路徑或任務狀態不符時拒絕驗收，不建立事件。
- 重複點擊、網路重送與並行 request 都不得產生第二筆事件。
- element-bot 不執行、解析或檢查任何 Git command；Git 結果只來自目標專案的 Codex 回報。
- approval processing 殘留於 worker 啟動時回收；專案端以 Task-ID 避免重複提交。
- 既有 `verified.json` 僅供歷史資料相容，新流程以 approval event 為準。

## 修改範圍

- Dashboard：`src/dashboard/server.js`、`src/dashboard/aggregate.js`、`src/dashboard/public/index.html`
- 規則與任務：`src/rules.js`、`src/trigger.js`、`src/dashboard/public/rules.html`、`config/rules.example.json`
- Worker／分派：`src/worker.js`、新增 approval queue 與 executor 模組、`src/taskDefs.js`
- 設定與文件：`.env.example`、`AGENT_CONTEXT.md`、`package.json`

## 測試

- 規則驗證及 `target_branch` 入列。
- 驗收欄位來源、伺服器時間、狀態限制、輸入驗證、路徑穿越與重複驗收。
- approval queue 原子建立、狀態搬移、失敗重試與 processing 回收。
- 通知 prompt 完整包含四欄、commit／push 指示與兩個 trailer。
- Dashboard 顯示保存的姓名、核准資料與發布狀態。
- 靜態防退化測試確認 element-bot source 沒有直接執行 Git，且 agent CLI 仍只由 `src/codexRunner.js` 啟動。
- 完成前執行 `npm test`、`git diff --check` 與真實隔離專案 smoke test。
