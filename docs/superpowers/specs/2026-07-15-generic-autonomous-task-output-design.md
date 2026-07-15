# 通用自主派發與完整 Codex 輸出設計

## 目的

element-bot 是純任務派發器。任何能由聊天室觸發、並交給 Codex 在規則指定目標中處理的工作，都可能成為任務；element-bot 不預先列舉任務類型，也不理解任務的業務內容。

本設計解決兩個已確認的問題：

1. 派發提示詞沒有明確表達「任務已核准且須無人值守完成」，Codex 可能停在自行增加的人工確認環節。
2. 現行結果 schema 強迫所有任務回傳 `changes`、`validation`、`commits` 等開發專屬欄位，造成輸出冗長，並可能掩蓋真正有用的 Codex 最終說明。

本設計取代 `2026-07-15-minimal-task-result-contract-design.md` 的實作方向。舊文件保留作為歷史紀錄，不刪除、不改寫。

## 責任邊界

element-bot 只負責：

1. 從聊天室訊息判斷規則並建立任務。
2. 將 command 派發至規則指定的 `project_path`。
3. 接收 Codex 回傳的通用狀態與完整說明。
4. 依回傳狀態更新 queue，並在 Dashboard 顯示完整說明。

element-bot 不負責：

- 判斷任務屬於修改程式、傳送訊息、觸發外部流程或其他類型。
- 檢查或解讀目標專案的 instructions、skills、MCP、Git 或業務規則。
- 判斷任務如何執行，或自行重新判斷任務是否完成。
- 使用第二次 LLM 呼叫摘要、改寫或分類第一次執行結果。
- 因為「沒有檔案改動」就將任務判定為失敗。

任務的完成條件由目標環境自己的 instructions、skills 與執行中的 Codex 決定。element-bot 相信該次 Codex 回傳的狀態與說明。

## 已驗證的根因

現行 Codex runner 的 execute mode 已使用：

- `--ask-for-approval never`
- `danger-full-access`
- network access

因此先前停在 `blocked` 並不是 CLI 權限詢問，而是 Codex 根據派發提示詞與目標專案規則做出的流程判斷。

現行派發提示詞只要求「完整執行」，沒有明確表示這是已核准的無人值守任務，也沒有禁止自行增加一般性的再次確認。另一方面，現行結果 schema 固定要求 `summary`、`changes`、`validation`、`commits`、`warnings`，即使任務與程式修改無關也必須填寫。

## 通用派發語意

`skill-dispatch` 名稱保留相容性，但提示詞不得假設任務類型。提示詞只加入以下通用執行語意：

- command 是使用者已核准交由本次無人值守流程執行的要求。
- 依目標環境自己的 AGENTS.md、instructions、skills 與安全規則處理。
- 不得自行增加一般性的「等待使用者再次確認」環節。
- 先依目標環境規則判斷任務是否已經完成。
- 如果已完成，回報 `success` 與可供人理解的證據，不重複執行。
- 如果尚未完成，直接執行到目標環境所定義的完成點。
- 只有缺少必要資料、外部條件不成立，或目標環境明確要求人工決策時，才回報 `blocked`。
- 不得輸出 token、密碼或其他秘密。

這些文字只描述派發授權與無人值守模式，不指定目標專案應使用哪個 skill，也不覆蓋目標環境自己的安全規則。

## 通用結果契約

Codex 單次執行只需回傳：

```json
{
  "status": "success | failed | partial | blocked",
  "output": "完整、可供人閱讀的最終說明"
}
```

欄位定義：

- `status`：Codex 依目標環境規則判定的本次任務狀態。
- `output`：Codex 原本應向直接使用者提供的完整最終回覆，可包含 Markdown、證據、外部識別碼、連結或失敗原因。

不得加入 `changes`、`commits`、`validation` 等任務類型專屬必填欄位。某個目標 skill 若認為這些資訊重要，可自行寫進 `output`，element-bot 不拆解也不改寫。

狀態對應：

- `success` → `done`
- `failed` → `failed`
- `partial` → `review`
- `blocked` → `blocked`

「任務之前已完成，因此本次不需重複操作」屬於 `success`，不是 `failed` 或 `blocked`。

## 顯示與紀錄

Dashboard 任務詳情以以下順序顯示：

1. 狀態。
2. `執行輸出 (Codex)`，內容為 `output` 原文。
3. 執行步驟與技術診斷等既有輔助資訊。

不得用 element-bot 自行產生的一句摘要取代 `執行輸出 (Codex)`。不得把完整輸出藏進預設收合區。不得同時重複顯示相同的 `output`。

完整 `output` 必須寫入工作目錄中的結果檔，供稽核與重新載入。若 UI 或 log 因安全上限必須截斷，畫面需明確標示截斷，且完整結果檔仍須保留；element-bot 不得使用 LLM 摘要替代被截斷內容。

舊任務的 `summary/changes/validation/commits/warnings` 與歷史 `ai_output` 仍須正常顯示，避免破壞既有紀錄。

## 可逆切換

驗收期間提供 `TASK_RESULT_MODE=generic|legacy`：

- `generic`：使用本設計的 `status + output` 與自主派發提示詞。
- `legacy`：使用目前既有的詳細結果 schema 與顯示方式。

完成驗收後預設為 `generic`。切換模式只需更新 element-bot 設定並重啟 worker，不修改任何目標專案。

## 失敗與例外處理

- Codex CLI 非零退出、timeout 或結果格式無效：worker 記為 `failed`，顯示實際錯誤，不偽造業務結果。
- Codex 回傳 `failed`：保留並顯示完整 `output`，queue 進入 `failed`。
- Codex 回傳 `partial`：保留並顯示完整 `output`，queue 進入 `review`。
- Codex 回傳 `blocked`：保留並顯示缺少的資料或人工決策原因，queue 進入 `blocked`。
- Codex 回傳 `success`：不再由 element-bot 以 Git、檔案變更或其他任務特定檢查推翻。

## 測試策略

依 TDD 實作，先建立會因現行行為而失敗的測試：

1. 派發提示詞包含已核准、無人值守、已完成不重做、不得自行等待再次確認等通用語意。
2. 派發提示詞與結果契約不包含 Git、commit、檔案修改、聊天室、客服或 Jenkins 等任務類型假設。
3. `status + output` 可正確解析、保存並映射 queue 狀態。
4. `success` 且沒有任何專案改動時，仍維持 `done`。
5. Dashboard 主要區域保留並顯示 `執行輸出 (Codex)`，不得只剩簡短結果。
6. `failed`、`partial`、`blocked` 仍顯示完整原因。
7. 舊 detailed 任務與歷史 `ai_output` 保持相容。
8. 真實 Codex smoke test 只在暫存目錄執行：測試「工作早已完成、無需再次操作」可回傳 `success` 與證據，不觸碰正式規則指向的目標專案。

完成前執行 `git diff --check`、`npm test` 與 `npm run test:codex-smoke`，並確認只有 `src/codexRunner.js` 啟動 Codex CLI。

## 驗收標準

- 任務類型增加時，不需要修改 element-bot 的結果契約。
- element-bot 不查看目標專案的 skill 或業務內容。
- 已完成且不需重做的任務顯示 `success/done`。
- Dashboard 始終保留有用的 `執行輸出 (Codex)`。
- 不再因固定開發專屬欄位而產生冗長結果。
- 不增加第二次 LLM 呼叫。
- 驗收不滿意時，可切回 `legacy` 而不需 Git 回退。
