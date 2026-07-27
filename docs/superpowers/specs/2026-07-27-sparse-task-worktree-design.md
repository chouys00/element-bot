# Task 專屬稀疏工作區設計

## 背景

`skill-dispatch` 目前要求目標專案 Codex 以 `git worktree add --detach` 建立每筆 Task 專屬工作區。當規則的 `project_path` 是大型 Git repository 內的子目錄時，Git 仍會把整個 repository 的受控檔案取出到 worktree。

在 `D:\test\ftl-element-bot-acceptance\ftl` 的實際案例中，Git repository 根目錄是上一層 `D:\test\ftl-element-bot-acceptance`。現行流程因此在處理 `ftl` 任務前，先取出四十多萬個檔案；任務長時間停留在準備工作區，尚未開始處理業務要求。

## 目標

- 保留每筆 Task 專屬 worktree，避免不同任務與共用工作目錄的修改互相混入。
- 當 `project_path` 是 Git repository 的子目錄時，只取出該子目錄與 Git cone 模式必要的根層檔案。
- 在建立稀疏範圍前，不得執行會取出完整 repository 的 checkout 或 `git reset --hard`。
- Dashboard 驗收後仍在同一個 Task 專屬 worktree 進行 commit 與 push。
- element-bot 維持分派器邊界，不直接執行 Git，也不檢查或修改目標專案的 instructions、skills 或工具體系。

## 非目標

- 不改變 Dashboard 驗收、approval outbox、commit 或 push 流程。
- 不從 ZenTao 內容猜測另一個專案路徑。
- 不替目標專案選擇需要修改的業務檔案。
- 不處理規則本身就指向 Git repository 根目錄時的 repository 縮減；此時整個 repository 就是規則指定範圍。

## 方案比較

### 方案 A：直接修改共用 `project_path`

速度最快，但會失去 Task 隔離。同時執行的任務、使用者原有的未提交修改與驗收後發布內容可能互相混入，不採用。

### 方案 B：保留目前的完整 worktree

隔離完整，但每筆任務都會取出整個大型 repository，正是本次問題的根因，不採用。

### 方案 C：`--no-checkout` 加 sparse checkout

先建立不含實體檔案的 detached worktree，再把稀疏範圍設定為規則指定的 repository 相對子目錄。它同時保留 Task 隔離與小範圍取出，採用此方案。

## 設計

### 初始任務

element-bot 繼續以規則的 `project_path` 作為 Codex 啟動目錄，並在 prompt 提供 `Task-ID`、`target_branch` 與 `queue/work/<task_id>/workspace`。

目標專案 Codex 在修改前必須：

1. 取得目前 `project_path` 所屬的 Git repository 根目錄。
2. 計算 `project_path` 相對於 repository 根目錄的路徑。
3. 若 `project_path` 是 repository 的子目錄：
   - 使用 `git worktree add --detach --no-checkout` 建立 Task 專屬 worktree。
   - 在任何 checkout 或 `git reset --hard` 前啟用 cone 模式 sparse checkout。
   - 將 sparse checkout 範圍設為上述 repository 相對子目錄。
   - 在 Task worktree 內對應的子目錄執行讀寫、驗證與產出。
4. 若 `project_path` 就是 repository 根目錄，建立一般 Task 專屬 worktree；因規則指定範圍就是整個 repository，不宣稱可以縮減取出範圍。
5. 若無法唯一確認 repository 根目錄、相對路徑或稀疏工作區狀態，回報 `blocked`，不得退回共用工作目錄，也不得改成完整 checkout。

cone 模式可能保留少量 repository 根層檔案與目標子目錄的父路徑檔案；不得取出其他同層大型子目錄。

### 重試與復用

若 Task 專屬 worktree 已存在，Codex 必須先確認它屬於同一 Task，並在繼續工作前確認 sparse checkout 範圍仍是規則指定的子目錄。不得以完整 checkout 或全 repository 的 `reset --hard` 修復工作區。

### 驗收與發布

approval event 的 `workspace_path` 仍指向 Task worktree 根目錄。驗收後的 Codex 從同一 worktree 檢查本 Task 變更、commit 並 push 到 `target_branch`。這部分資料格式與流程不變。

## 錯誤處理

- Git 不支援所需 sparse checkout、路徑不在同一 repository、worktree 已被其他 Task 使用，或稀疏範圍無法確認時，任務回報 `blocked` 並說明原因。
- 禁止為了繼續執行而退回共用 `project_path`。
- 禁止為了繼續執行而先取出完整 repository。

## 測試

- `taskDefs` 單元測試確認 prompt 明確要求 `--no-checkout`、sparse checkout、子目錄相對路徑與失敗時 `blocked`。
- 單元測試確認 prompt 禁止在設定 sparse checkout 前執行完整 checkout 或 `git reset --hard`。
- executor 測試確認工作區規則會隨任務 prompt 傳給 Codex，且 Codex 啟動目錄仍是規則的 `project_path`。
- 真實 Codex smoke test 使用暫存 Git repository：規則指向其中一個子目錄，執行後確認 Task worktree 內有目標子目錄，且大型同層子目錄沒有被取出。
- 完成前執行 `npm test`、`npm run test:codex-smoke`、`git diff --check`，並確認 `src/` 沒有直接啟動其他 agent CLI 或 Git command。

## 成功條件

- 規則指向 repository 子目錄時，新任務不再取出其他大型同層目錄。
- 任務仍只在自己的 worktree 修改，Dashboard 驗收後能在同一 worktree 發布。
- 無法安全建立稀疏 worktree 時明確停止，不污染共用工作目錄。
