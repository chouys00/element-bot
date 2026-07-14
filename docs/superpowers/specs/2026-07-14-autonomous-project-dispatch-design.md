# Element-bot 專案自治派發設計

日期：2026-07-14

## 背景

Element-bot 的責任是把聊天室命中的指令派發到規則指定的目標專案。目標專案各自具備可獨立運行的 instructions 與 skills，並自行決定如何取得任務資料、修改代碼、驗證結果及提交版本。

Claude runtime 原本以 `--dangerously-skip-permissions` 執行正式任務。遷移到 Codex 後，正式任務改用 `workspace-write`，且派發 prompt 加入「不得讀寫工作目錄之外」與版本控制限制。這使 Codex 無法完整執行原本可獨立運行的專案 skill；例如 FTL 的禪道 skill 必須讀取及在過期時更新使用者目錄下的 token。

## 目標

- Element-bot 只決定目標專案與派發 command，不介入目標專案的工作流程。
- 正式派發的 Codex 具備與使用者在目標專案直接執行任務相同的能力。
- 目標專案自行遵循其 `AGENTS.md`、instructions 與 skills。
- 目標專案自行決定修改、驗證、commit 及所需外部資源。
- Element-bot 能可靠區分成功、失敗、受阻與部分完成，並把結構化結果回傳到既有任務流程與介面。
- Judge 與 probe 仍維持低權限，不因正式執行權限放寬而擴權。

## 非目標

- Element-bot 不理解或維護各專案的 skill 位置、憑證位置、驗證命令或 commit 規則。
- Element-bot 不替目標專案執行測試，也不重新判斷專案驗證是否正確。
- 不根據聊天訊息動態指定任意工作目錄；目標路徑仍來自管理者維護的規則。
- 不把 token 或其他秘密內容注入 prompt、任務 JSON 或 log。

## 權責邊界

### Element-bot 負責

1. 依規則判斷是否觸發任務。
2. 取得規則中設定的目標專案路徑與渲染後 command。
3. 以目標專案為 `cwd` 啟動 Codex。
4. 管理 timeout、取消與整棵 process tree 終止。
5. 驗證 Codex 程序是否正常結束，以及最終結果是否符合回報 schema。
6. 保存並轉發結構化結果。
7. 可額外蒐集 git 變動與 commit 作為顯示用觀測資料，但不以此判定任務成功。

### 目標專案 Codex 負責

1. 讀取目標專案自己的 `AGENTS.md`、instructions 與 skills。
2. 把派發 command 當成使用者直接在該專案提出的要求。
3. 自行取得完成 skill 所需的專案內外資源及網路資料。
4. 自行決定如何修改代碼、執行驗證及是否 commit。
5. 根據實際完成狀況回傳結構化結果與驗證證據。

## 正式任務執行模式

`execute` 模式改用 Codex `danger-full-access`，網路保持可用，approval 保持 `never`，以支援無人值守且還原原本 Claude runtime 的執行能力。

只有正式 `execute` 模式使用完整權限：

| 模式 | Sandbox | 網路 | 用途 |
|---|---|---|---|
| `judge` | `read-only` | 關閉 | 判斷訊息是否觸發及抽取參數 |
| `probe` | `read-only` | 關閉 | 唯讀檢查規則與專案連通性 |
| `execute` | `danger-full-access` | 開啟 | 讓目標專案獨立完成任務 |

完整權限的信任邊界是「規則設定的目標專案」，而不是聊天室輸入。聊天室內容只能成為 command，不能覆寫 `project_path` 或 Codex 啟動參數。

## 派發 Prompt

正式派發 prompt 只傳達執行上下文與回報義務，不再加入專案流程政策。語意如下：

```text
你正在規則指定的目標專案中執行任務。
請把下方 command 視為使用者直接在此專案提出的要求。
依此專案自身的 AGENTS.md、instructions 與 skills 完整執行。
command：<rendered command>
完成後依指定 schema 回報實際結果與證據。
```

應移除以下 element-bot 層級限制：

- 不得讀寫工作目錄之外。
- 只有目標專案 instructions 或 skill 明確要求才能 commit。
- 預設不 commit，以及禁止「自作主張」commit 的評語。
- 任何指定 skill 位置、驗證方式或外部資源白名單的專案特定邏輯。

## 結構化結果協議

正式 `execute` 使用 Codex CLI output schema 強制最後輸出 JSON。結果至少包含：

```json
{
  "status": "success",
  "summary": "已完成任務的簡要說明",
  "changes": ["實際完成的修改或產出"],
  "validation": [
    {
      "command": "實際執行的驗證命令或檢查名稱",
      "status": "passed",
      "detail": "驗證結果摘要"
    }
  ],
  "commits": [
    {
      "hash": "abc1234",
      "message": "fix: example"
    }
  ],
  "warnings": []
}
```

欄位規則：

- `status` 必須是 `success`、`failed`、`blocked` 或 `partial`。
- `summary` 必須是非空字串。
- `changes`、`validation`、`commits`、`warnings` 必須存在，可為空陣列。
- `validation[].status` 必須是 `passed`、`failed`、`skipped` 或 `not_applicable`。
- 不得在任何欄位回傳 token、密碼或其他秘密內容。
- 沒有修改、沒有驗證或沒有 commit 都是合法情況；需以空陣列或對應的 validation 狀態明確表達。

## 狀態判定

Element-bot 先判斷執行層，再判斷任務層：

| 執行情況 | 結果 `status` | Element-bot 結果 |
|---|---|---|
| timeout、取消、被終止或非零 exit code | 任意 | `failed` |
| 正常結束但無法解析或不符合 schema | 無 | `failed`，原因為回報協議錯誤 |
| 正常結束 | `success` | `done` |
| 正常結束 | `failed` | `failed` |
| 正常結束 | `blocked` | `blocked` |
| 正常結束 | `partial` | `review` |

`success` 代表目標專案代理依自身流程確認任務完成。Element-bot 不以 git diff、是否 commit 或測試命令名稱覆蓋此判定。

## Git 與驗證資料

- 移除派發前「工作區必須乾淨」的強制攔截，避免 element-bot 替專案制定起跑條件。
- 移除「沒有 git 變動即失敗」及「有 commit 是否違規」的語意判斷。
- 若現有 dashboard 需要，element-bot 可在執行前後唯讀蒐集 HEAD、工作區變動與新增 commit，作為觀測資料附加到結果。
- 觀測資料不得改變目標代理回報的 `status`，也不得觸發 reset、checkout、commit 或其他 git 寫入。
- 目標代理回報的 `validation` 是完成證據；element-bot 只顯示，不重跑也不解讀專案特定驗證。

## 錯誤處理

- Codex 啟動失敗、timeout、process tree 終止失敗及非零 exit code，沿用 runner 的基礎設施錯誤處理並標為 `failed`。
- 結果缺欄、狀態值不合法或輸出不是 schema JSON 時，標為回報協議錯誤，保存可安全顯示的 stderr/stdout 摘要。
- `blocked` 必須在 `summary` 說明阻塞原因；element-bot 原樣轉發，不擅自要求 Chrome 或指定解法。
- `partial` 必須在 `changes` 與 `warnings` 清楚說明已完成及未完成部分。
- 結果解析與日誌處理不得輸出 prompt 中未要求公開的秘密內容。

## 測試策略

### Runner 單元測試

- `judge` 與 `probe` 仍為 `read-only` 且不開網路。
- `execute` 使用 `danger-full-access` 且開網路。
- `--ask-for-approval never`、stdin prompt、ephemeral、timeout 與 process tree cleanup 保持有效。
- Output schema 只套用到正式結果協議所需的呼叫，並能正確傳給 Codex CLI。

### Task definition 單元測試

- Prompt 只包含目標專案自治指示、command 與回報要求。
- Prompt 不再包含專案外讀寫限制、commit 政策或特定 skill 路徑。

### Executor 單元測試

- 四種合法 `status` 正確映射到任務狀態。
- 非零 exit、timeout、格式錯誤及 schema 錯誤一律失敗。
- 沒有 git diff 的 `success` 仍為成功。
- 已 commit、工作區乾淨的 `success` 仍為成功。
- Git 觀測資料不覆蓋目標代理回報狀態。
- 派發前不因工作區已有變動而拒絕啟動。

### 整合與實跑驗收

1. 使用不改檔的測試任務，確認可回報 `success` 與空 `changes`。
2. 使用會改檔但不 commit 的測試 skill，確認結果與變動能回傳。
3. 使用會自行驗證並 commit 的測試 skill，確認工作區乾淨時仍判定成功。
4. 使用模擬 `blocked`、`partial`、非零 exit 與畸形輸出的任務，確認狀態映射。
5. 在 FTL 專案透過 element-bot 派發禪道 URL，確認能依專案 skill 讀取或刷新 token、取得禪道資料、修改代碼、驗證及 commit，並把結構化結果回傳 element-bot。

## 驗收標準

- 同一個 command 在目標專案直接執行與透過 element-bot 派發時，使用相同的專案 instructions/skills，且不因 element-bot 額外政策而改變流程。
- Element-bot 不包含 FTL、禪道或其他目標系統的專用路徑與邏輯。
- Element-bot 能顯示目標代理回報的摘要、修改、驗證、commit 與警告。
- 成功與否由程序狀態及合法的結構化結果決定，而不是由 git 是否產生變動決定。
- Judge/probe 權限維持不變，正式 execute 才取得專案完成任務所需的完整權限。
