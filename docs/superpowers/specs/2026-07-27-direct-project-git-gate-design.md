# 直接專案路徑與 Git 起跑閘門設計

## 狀態

本文件取代尚未實作的 `2026-07-27-sparse-task-worktree-design.md`。先前的 sparse worktree 方案不再進行。

## 背景

element-bot 在 2026 年 6 月 30 日採用「直接改本體」模型：執行前以 `git status --porcelain .` 確認規則指定的 `project_path` 沒有未提交修改，然後讓 Codex 直接在該路徑工作。

2026 年 7 月 14 日導入結構化結果時，Git 乾淨檢查被移除。2026 年 7 月 21 日加入 Dashboard 驗收後發布流程時，為避免多個未驗收任務互相混入，改成每筆 Task 建立獨立 Git worktree。大型 repository 因此會在業務任務開始前取出數十萬個檔案，造成長時間卡在準備階段。

本設計恢復直接修改 `project_path`，並保留後來新增的 Dashboard 驗收、approval outbox、發布重試、重啟復原與冪等保護。

## 目標

- Codex 直接在規則指定的 `project_path` 修改與驗證，不建立或複製 Task worktree。
- 新任務啟動前，以唯讀 Git 檢查確認目標路徑乾淨且目前分支符合 `target_branch`。
- 目標路徑有未提交修改時，任務留在 `pending`，不啟動 Codex、不增加執行嘗試次數。
- 一次只從 queue 啟動一項新任務；前一項留下的修改未完成驗收與發布前，下一項不得開始。
- Dashboard 驗收後，由既有 approval worker 回到同一個 `project_path` 執行 commit 與 push。
- 保留結構化結果、Task-ID、公司 ID、target branch、發布重試、結果未知、重啟復原、通知、關閉與重新開啟功能。

## 非目標

- 不自動 reset、checkout、stash、commit、push 或清除目標專案。
- 不檢查、猜測或修改目標專案的 instructions、skills、MCP 或其他工具體系。
- 不讓歷史任務自動取得新的發布資格。
- 不恢復已移除的舊版任務結果格式。
- 不回退 2026 年 7 月 21 日整筆提交中的 approval 原子寫入、重試、復原與對帳保護。

## 方案比較

### 方案 A：完整回退 worktree 提交

會連帶移除 approval 原子建立、失敗重試、結果未知與重啟復原等後續修正，不採用。

### 方案 B：精準恢復直接修改與 Git 起跑檢查

只移除 worktree 依賴，重新加入唯讀 Git 起跑檢查；其他發布可靠性功能原樣保留。符合原始操作方式與目前需求，採用此方案。

### 方案 C：保留 worktree 並改成 sparse checkout

能保留多任務隔離，但仍增加 worktree 建立、復用與清理流程，不符合「直接修改指定 `project_path`」的決策，不採用。

## 整體流程

```text
Matrix 訊息
  → 規則／LLM 判斷
  → queue/pending
  → 新任務 Git 起跑檢查
      ├─ dirty 或分支不符：留在 pending，不啟動 Codex
      ├─ 路徑或 Git 設定無效：移入 blocked，顯示原因
      └─ 乾淨且分支正確：Codex 在 project_path 修改與驗證
  → done／review／blocked／failed
  → Dashboard 人工驗收
  → approval outbox
  → Codex 在同一 project_path commit、push
  → approval done
  → project_path 乾淨後，下一項 pending 任務才可開始
```

## 新任務起跑檢查

worker 每輪只嘗試啟動排序後的第一項 `pending` 任務，不再同一輪把所有 pending 任務依序跑完。

對全新 `skill-dispatch` 任務，在搬入 `processing` 與啟動 Codex 前執行：

1. 確認 `project_path` 存在且是目錄。
2. 以該路徑為 `cwd` 執行唯讀 Git 查詢，確認它位於 Git repository。
3. 執行等價於 `git status --porcelain -- .` 的範圍檢查；偵測 tracked、untracked、staged 與 unstaged 修改。
4. 取得目前分支並確認等於任務的 `target_branch`。

結果分流：

- 工作區 dirty：任務保持 `pending`，本輪停止；不呼叫 Codex、不建立 task-result、不增加 attempt。
- 分支不符或 detached HEAD：任務保持 `pending`，本輪停止；不得自動切換分支。
- 路徑不存在、不是目錄、不是 Git repository 或 Git 查詢失敗：任務移入 `blocked` 並保存可顯示的原因。
- 乾淨且分支正確：任務移入 `processing`，開始既有 executor 流程。

這項 Git 查詢是 element-bot runtime 唯一允許直接啟動 Git 的例外，而且只能是唯讀狀態與分支查詢。Codex 仍只能由 `src/codexRunner.js` 啟動。

## 中斷與重跑

同一 Task 已有 checkpoint，且 `prepare` 已完成時，代表該 Task 曾開始修改。worker 回收或人工 requeue 後，必須允許它從既有 checkpoint 繼續，不得讓它被自己留下的 dirty changes 擋住。

全新 Task 沒有上述 checkpoint，必須通過完整起跑檢查。這使中斷復原仍能工作，同時避免下一項 Task 接手前一項未提交修改。

## 初始 Codex 任務

Codex 的 `cwd` 保持為規則指定的 `project_path`。prompt 必須：

- 明確要求所有修改與驗證直接在目前 `project_path` 完成。
- 保留 `Task-ID` 與 `target_branch`。
- 明確禁止驗收前 commit 與 push。
- 移除建立、復用或檢查 Task worktree 的所有指示。
- 保留目標專案自治與結構化結果要求。

## Dashboard 驗收與發布

approval event 保留：

- `task_id`
- `project_path`
- `target_branch`
- `approved_by`
- `approved_at`
- `attempt` 與既有重試／復原欄位

新事件不再建立或要求 `workspace_path`。approval executor 以 `project_path` 為 `cwd`，通知目標專案 Codex：

- 確認目前分支與 `target_branch`。
- 只提交本次待驗收修改。
- commit message 保留 `Task-ID` 與 `Approved-by` trailers。
- push 到 `target_branch`。
- 依 Task-ID 對帳，重送時不得重複 commit。
- 完成後確認沒有遺留未提交修改；若仍 dirty，明確回報。

approval outbox 的 pending／processing／done／failed／unknown 狀態、原子建立、失敗重試、結果未知、重啟復原與 Dashboard 顯示保持不變。

## 關閉與人工處理

Dashboard「關閉」只關閉任務紀錄，不得修改目標專案。若任務留下未提交修改，即使任務已關閉，下一項仍保持 `pending`；使用者必須先人工完成、提交或還原該修改。

發布失敗時，修改仍留在 `project_path`，因此下一項任務保持等待。使用者可使用既有「重試發布」，或人工修復後再繼續。

## 相容性

切換前現況：

- 沒有 `judging`、`pending`、`processing` 或 `publishing` 中的活動任務。
- approval pending／processing／failed／unknown／done 目錄均沒有事件。
- 九筆歷史待驗收任務都沒有 worktree，也都缺少 `target_branch`，既有驗證會繼續拒絕發布。

因此不需要轉換進行中的 approval event。歷史任務不會因本次調整自動取得發布資格。

## 影響範圍

需要調整：

- 任務起跑檢查與 worker 每輪處理策略。
- `skill-dispatch` 初始 prompt。
- approval event 的 worktree 驗證。
- approval executor 的執行路徑與 prompt。
- runtime 靜態邊界測試、單元測試、真實 Codex smoke test 與現行操作文件。

不受影響：

- Matrix 監聽、規則命中、LLM judge 與參數抽取。
- `project_path` 與 `target_branch` 的規則設定及任務入列。
- Codex runner 的 timeout、process tree cleanup、sandbox 與 output schema。
- 結構化結果、checkpoint、進度 log、通知與 Dashboard 狀態彙整。
- approval outbox、公司 ID、commit trailers、重試、對帳、結果未知與重啟復原。
- Dashboard 任務關閉與重新開啟。
- bot、worker、Dashboard 的啟動與重啟流程。

## 測試

- 新增 Git 起跑檢查單元測試：乾淨、dirty、錯誤分支、detached HEAD、非 Git 路徑與查詢失敗。
- worker 測試確認 dirty／分支不符時任務留在 pending、Codex 未被呼叫、attempt 未增加，且本輪不處理後續任務。
- checkpoint 測試確認同一 Task 中斷後可在 dirty `project_path` 繼續。
- prompt 測試確認直接修改 `project_path`、驗收前禁止 commit／push，且不含 worktree 指示。
- approval store 測試確認新事件不需要 `workspace_path`，其他驗證、原子建立與重試保持有效。
- approval executor 測試確認 Codex 以 `project_path` 啟動，並保留分支、trailers、冪等與失敗回報。
- 真實 Codex smoke test使用暫存 repository：
  - dirty 時不啟動初始 Codex。
  - 乾淨時直接在 `project_path` 產生未提交修改。
  - Dashboard 驗收後 commit、push 並清理工作區。
  - 未驗收前的下一項任務不會啟動。
  - 重送 approval 不會重複 commit。
- 完成前執行 `npm test`、`npm run test:codex-smoke`、`git diff --check`。
- 靜態檢查確認只有指定 Git 起跑檢查模組可執行唯讀 Git，且只有 `src/codexRunner.js` 可啟動 agent CLI。

## 成功條件

- 新任務不建立 worktree，也不複製大型 repository。
- 目標路徑 dirty 或分支不符時，任務等待且不啟動 Codex。
- 初始任務直接在 `project_path` 留下待驗收修改。
- 驗收後在同一路徑完成 commit 與 push，並保留所有後續發布可靠性功能。
- 中斷任務能續跑，下一項任務不會接手尚未完成的修改。
