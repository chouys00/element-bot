# element-bot Codex 執行架構遷移設計

## 目標

將 Claude Code 執行環境替換為 Codex，同時讓 `element-bot` 嚴守分派器的責任邊界：監聽 Matrix 聊天室、判斷與擷取訊息意圖、將任務排入佇列，以及把渲染完成的指令分派至規則指定的目標專案。

本次遷移不得檢查、搬移、驗證或修改任何目標專案的 instructions 或 skill 體系。Codex 進入目標專案後，應自行依該專案的設定解讀並執行其 instructions 與 skills。

## 範圍

本次變更只適用於 `D:/GB/element-bot`。

包含：

- 將所有執行期 `claude` CLI 呼叫替換為 `codex exec`。
- 集中管理 Codex 程序建構、權限、逾時、stdout 與 stderr 行為。
- 從通用分派與 probe 提示詞中移除 `.claude/skills`、`.agents/skills`、`.cursor/skills` 或其他目標 skill 路徑假設。
- 移除特殊任務 `i18n-skill`，因為它直接持有目標專案的 skill 路徑及驗證腳本。
- 對外部專案只保留通用的 `skill-dispatch` 分派方式；最終審查確認 `demo-skill` 仍會把 `SKILL.md` 結構帶入正式 task 清單，因此一併移除。
- 將 element-bot 自身的 repository skills 從 `.claude/skills` 遷移至 `.agents/skills`。
- 更新原始碼、測試、log、dashboard 顯示文字與現行操作文件中的 Claude 執行期命名。
- 新增可長期保存的遷移與還原文件。
- 新增單元測試與可選擇執行的真實 Codex smoke test。
- 任務對話、回覆、設計文件與實作計畫使用繁體中文；程式識別字、CLI 指令與必要技術名詞維持原文。

不包含：

- 修改 `D:/GB/PC/ftl` 或任何其他目標專案。
- 遷移或驗證目標專案的 skills。
- 建立多 provider 抽象層或 Claude fallback。
- dashboard 身分驗證；既有遠端存取風險會留下紀錄，但屬於另一項變更。
- 重寫忠實描述過去 Claude 行為的歷史設計文件、計畫或 changelog。

## 架構

### 執行期邊界

新增 `src/codexRunner.js`，作為唯一允許建構或啟動 Codex CLI 的模組。最終只提供非同步執行函式；Windows 不經 shell 啟動，timeout 時以 PID 終止完整 process tree，避免舊任務在 worker 重試後繼續寫檔。

兩種函式共用同一個參數建構器，避免不同呼叫端的權限與 CLI 語法逐漸分歧。

執行模式：

| 模式 | 用途 | Codex sandbox |
| --- | --- | --- |
| `judge` | 意圖分類與參數擷取 | `read-only` |
| `probe` | 唯讀連通測試與分派說明 | `read-only` |
| `execute` | 執行目標專案任務 | 開啟網路的 `workspace-write` |

每次呼叫一律使用：

- `codex --ask-for-approval never exec`
- `--ephemeral`，避免聊天室訊息與任務提示詞形成持久 Codex session
- `--color never`，讓 log 穩定可解析
- 使用 `-` 從 stdin 傳入 prompt
- 將設定的專案目錄作為 `cwd`
- 分別擷取 stdout 與 stderr

成功時只回傳 stdout，也就是 Codex 最終回答。stderr 只保留作診斷，並僅在失敗時附入錯誤。非零 exit code、spawn 錯誤或逾時，都應產生 provider-neutral 的錯誤訊息，且限制診斷文字長度。

任何模式都不使用 `danger-full-access` 或 `--dangerously-bypass-approvals-and-sandbox`。`execute` 模式明確加入 Codex 設定 `sandbox_workspace_write.network_access=true`：目標專案流程可能合理需要 API 或套件來源，但檔案寫入範圍仍限制在目標 workspace。`judge` 與 `probe` 不開放網路。

### Judge 結構化輸出

保留既有 judge schema 與 parser 作為應用層契約。runner 接受選填的 output schema，為 `--output-schema` 寫入暫存檔，執行結束後刪除。這讓 Codex 使用原生結構化輸出限制，同時保留既有 retry 與驗證行為。

### 分派邊界

`skill-dispatch` 只接收：

- 設定好的目標專案路徑
- 渲染完成的 command
- 關於工作範圍與版本控制行為的安全限制

提示詞應要求 Codex 將渲染後的 command 視為使用者要求，並依目標專案自身的 instructions 與可用 skills 執行。提示詞不得提及或搜尋 `.claude/skills`、`.agents/skills`、`.cursor/skills` 等特定目錄。

Probe 遵守相同邊界。它只回報工作目錄、收到的 command，以及 Codex 根據目標專案設定預計採用的流程。Probe 維持唯讀。

`projectCheck` 繼續只驗證路徑存在、Git repository 狀態與工作區乾淨度，不加入 skill discovery 邏輯。

### 任務定義

移除 `i18n-skill`、其 `NSL_SKILL_DIR` 相依項，以及針對目標專案的驗證指令。若現有規則仍使用此任務，必須由管理者明確改成 `skill-dispatch`；element-bot 應對過時的任務名稱驗證失敗，不得靜默猜測目標 command。

不保留 `demo-skill`；測試 fixture 不得出現在正式 `taskNames()`，也不得要求目標專案具有固定 `SKILL.md`。

### Repository skills 與 instructions

Element-bot 自身的操作 skills 存放於 `.agents/skills` 並納入 Git。移除已追蹤的 `.claude/skills` 副本。Setup skill 使用 `codex exec` 驗證 Codex，但對目標專案只檢查通用分派器需要的條件：路徑存在、為 Git repository、工作區乾淨。

新增根目錄 `AGENTS.md`，保存以下長期規則：

- 只有 `src/codexRunner.js` 可知道 Codex CLI 參數
- 通用分派必須對目標 skill 體系保持中立
- 目標專案不屬於此 repository 的修改範圍
- 任務對話、回覆、設計與計畫一律使用繁體中文
- 必須執行的測試與 smoke-test 指令

## 設定

保留 `AI_TIMEOUT_MS` 與 `JUDGE_TIMEOUT_MS`。新增 `CODEX_COMMAND`，預設為 `codex`，讓部署環境可以指定絕對執行檔路徑，而不需要導入其他 provider。

不新增 `AI_PROVIDER`；Codex 是唯一支援的執行環境。

## 測試

所有行為變更遵守 TDD。

1. 為三種模式新增參數建構單元測試。
2. 使用注入的 child-process 函式測試 stdin、cwd、逾時、exit-code 錯誤，以及 stdout/stderr 分離。
3. 更新 judge、probe、executor、handler、progress 與 dashboard 測試，使用 Codex-neutral 命名與輸出。
4. 新增斷言，確保通用分派與 probe 提示詞不含已知目標 skill 目錄。
5. 新增 task-definition 測試，確認 `i18n-skill` 不再註冊。
6. 執行 `npm test`。
7. 新增可選的 `npm run test:codex-smoke`。此腳本建立臨時 Git repository，驗證唯讀 Codex 回覆、驗證 workspace-write 檔案修改、檢查結果後移除臨時 repository。它不得開啟或修改任何設定中的正式目標專案。
8. 搜尋現行 runtime source 與有效文件，確認不再存在 `claude` spawn 或目標 skill 路徑假設。歷史 plans 與 changelog 不在此斷言範圍。

## 文件與還原

新增 `docs/codex-runtime-migration.md`，內容包含：

- 現行 Codex 指令與權限對照
- stdout/stderr 行為
- 本次遷移修改的所有現行檔案
- 未來換 provider 時唯一應替換的執行期邊界
- 依 Git commit 精準恢復 Claude 的檢查表，不建議全 repository 大範圍取代
- 警告不得機械式重寫歷史文件

使用以下順序建立聚焦 commit：

1. 設計規格。
2. Codex runner 與測試。
3. 執行期呼叫端與 task-definition 遷移。
4. Repository skills、instructions、UI 文字與遷移文件。
5. 必要時加入最終驗證修正。

此 Git 歷史應能讓未來維護者只檢查或還原單一遷移層，不觸碰無關的 Matrix、queue、dashboard 或目標專案行為。

## 操作驗證與交付

完整測試與真實 Codex smoke test 通過後：

1. 使用既有 npm scripts 啟動 bot、worker 與 dashboard。
2. 確認三個程序保持運行，並檢查目前 log。
3. 確認 dashboard status endpoint 有回應。
4. 提供 dashboard URL 與程序識別資訊，交由使用者驗收。

不得自動觸發正式目標專案任務。最後的聊天室訊息驗收由使用者自行執行。

## 本次遷移範圍外的已知風險

Dashboard 可能設定為遠端存取，但 mutation 與 LLM endpoints 沒有身分驗證。本次遷移不處理此獨立安全問題。Codex 各模式只取得必要的最小權限，避免遷移擴大既有權限邊界。
