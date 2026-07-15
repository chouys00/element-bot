# Element-bot 最小結果契約試行設計

日期：2026-07-15

## 背景

目標專案直接執行 skill 時，Codex 已能產出簡短且有重點的自然語言結果。Element-bot 現行 execute 流程另外要求 `status`、`summary`、`changes`、`validation`、`commits`、`warnings` 六個欄位，導致 Codex 把分析、方案與步驟塞進 `changes`。Dashboard 又同時顯示拆解欄位與完整 JSON，因此同一結果重複且冗長。

17:35 的 #74898 任務證明目標專案 skill 能讀取 ZenTao 並換發 token，但 headless 派發停在等待核准，也沒有先找出 `origin/live` 已存在的完成 commit。這是派發契約問題，不應透過修改 FTL 或 ZenTao skill 解決。

## 目標

- Element-bot 只分派 `project_path` 與 `command`，不介入目標專案如何執行。
- 目標專案的自然語言結果完整保留，不再拆成多個專案語意欄位。
- Dashboard 預設只顯示一次結果，不重複顯示 JSON。
- 任務先判斷是否已完成；已完成即回成功與證據，未完成則無人值守執行，不停在等待核准。
- 試行期間可以快速切回現行詳細契約，支援來回實測。

## 非目標

- 不修改任何目標專案的 AGENTS.md、instructions 或 skills。
- 不讓 element-bot 解讀 ZenTao、Git 分支策略或專案特定結果。
- 不新增第二次 LLM 摘要呼叫。
- 不重寫或搬移既有歷史任務日誌。

## 派發契約

Element-bot 仍以目標專案為 `cwd` 啟動 Codex，只加入通用的無人值守語意：

1. 把 `command` 視為使用者直接在目標專案提出且已核准執行的要求。
2. 先依目標專案自身流程判斷任務是否已完成，包含專案認為必要的歷史與證據檢查。
3. 已完成時不得重複修改，直接回報成功及目標專案找到的證據。
4. 未完成時直接依專案流程執行，不停在計畫或等待下一輪核准。
5. 資訊不足或無法完成時回報失敗；只有實際完成部分產出時才能回報部分完成。

這些規則只描述無人值守工作方式，不指定任何 skill、憑證、Git 命令或目標系統。

## 最小結果契約

試行格式只保留兩個欄位：

```json
{
  "status": "success",
  "result": "目標專案 Codex 原本要回覆給使用者的完整自然語言結果"
}
```

### 欄位規則

- `status`：`success`、`failed` 或 `partial`。
- `result`：非空字串，保留目標專案的自然語言結果，不由 element-bot 改寫或摘要。
- `success`：任務已完成，或專案已確認先前完成而不需重複修改。
- `failed`：任務沒有完成，包含缺資料、缺權限、等待核准或其他阻塞。
- `partial`：確實已有部分產出，但仍有未完成項目。

Queue 映射固定為：`success → done`、`failed → failed`、`partial → review`。

## 可回退試行

新增 `TASK_RESULT_FORMAT`：

- `minimal`：使用 `status + result`，作為試行預設值。
- `detailed`：保留現行六欄位契約，僅供試行期間快速回退與比較。

切換設定後重啟 worker 即生效。兩種格式共用同一個 Codex runner，不新增 provider 分支。試行穩定後可另行決定是否刪除 `detailed`。

## 日誌與 Dashboard

- Queue log 先保存 Codex 原始 stdout，供稽核與除錯。
- `minimal` 結果解析後只顯示 `result` 一次。
- 原始 stdout 與步驟紀錄放入預設收合的「技術詳情」。
- 若原始 stdout 就是結果 JSON，不在主要畫面再次完整顯示。
- 歷史詳細格式仍能讀取；Dashboard 保留相容顯示，但原始 JSON同樣預設收合。
- 通知使用 `status` 與 `result`，不再組合不存在的詳細欄位。

## 錯誤處理

- Codex timeout、非零 exit、結果不是合法 JSON 或不符合所選 schema：任務進 `failed`。
- `minimal.result` 為空：契約錯誤，任務進 `failed`。
- 顯示層失敗不得改變 queue 狀態；仍可查看原始 log。
- Element-bot 不根據 `result` 文字重新推斷成功或失敗。

## 測試

- 最小 schema 只允許 `status` 與 `result`。
- 三種狀態正確映射到 `done`、`failed`、`review`。
- `blocked` 不再是最小格式合法狀態。
- Prompt 明確包含已核准、先檢查是否完成、不得等待核准。
- `TASK_RESULT_FORMAT=minimal|detailed` 選到正確 schema。
- Dashboard 對 minimal、detailed 與歷史日誌都能顯示，主要結果不重複。
- 真實 smoke test 驗證 Codex 能回傳最小格式與自然語言 `result`。
- 正式驗收使用不修改目標專案的已完成任務，確認能回報 `success` 並顯示完成證據。

## 驗收標準

- 同一個已完成任務直接在專案執行與透過 element-bot 派發，核心結論一致。
- Element-bot 畫面預設只顯示目標專案自然語言結果一次。
- 日誌不再因六欄位契約自動產生大段分析與計畫。
- Element-bot repository 不包含 FTL、ZenTao 或目標 skill 的專用邏輯。
- 可只改 `.env` 並重啟 worker，快速在 minimal 與 detailed 間來回測試。
