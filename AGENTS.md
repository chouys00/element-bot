# element-bot repository instructions

## 溝通語言

- 任務對話、回覆、設計文件與實作計畫一律使用繁體中文。
- 程式識別字、CLI 指令、環境變數與必要技術名詞維持原文。

## Agent runtime 邊界

- Codex 是唯一支援的 agent runtime。
- 只有 `src/codexRunner.js` 可以建構 Codex CLI 參數或啟動 `codex`。
- 其他模組只能呼叫 runner 匯出的 `preflightCodexRuntime()`、`runCodex()` 或 `deleteCodexSession()`，不得直接使用 `child_process` 解析或啟動 agent CLI。
- Codex 必須由 OpenAI 簽署，並且 `codex login status` 必須明確回報 `Logged in using ChatGPT`；API Key、自訂 provider/base URL、未登入或不明狀態一律停止。
- 不得 fallback 到其他 agent 或任何會額外計費的 API；安全檢查失敗時不得啟動模型。
- Windows timeout 必須終止完整 Codex process tree；不得改回同步 runner 或 `shell:true`。
- 不得更換 provider 或加入其他 agent 相容層；若 runtime 不合格只能中止並提示修正環境。
- 歷史 `docs/superpowers/` 與 `CHANGELOG.md` 應保留當時實際使用的工具名稱。
- 真正修改專案的 execute 任務必須保存精確 Codex session ID；驗收與人工重試只能 resume 該 ID，不得使用 `--last` 猜測對話，也不得在缺少 ID 時另開對話。
- `judge` 與 `probe` 等不需後續續接的內部執行維持 `--ephemeral`；execute、驗收與重試不得使用 `--ephemeral`。
- element-bot 建立的 session 在推送成功或任務人工關閉後保留 7 天，再由 worker 要求 `deleteCodexSession()` 透過官方 app-server `thread/delete` 刪除；不得直接刪除 Codex 檔案或修改其資料庫。等待驗收、推送失敗、結果未知、舊資料或證據不足時不得刪除。
- session 清理最多每 24 小時檢查一次，只能使用 `queue/work/<task_id>/codex-session.json` 記錄的精確 UUID；清理失敗不得影響任務或推送狀態。
- 任務重新執行產生新 session 時必須保留舊 ID，直到同一任務進入可清理狀態後一併刪除；每日清理水位必須跨 worker 重啟保存，重新開啟與清理必須以跨程序鎖避免競態。

## 分派器責任

- element-bot 只負責監聽 Matrix、判斷與擷取訊息、排入 queue，以及把 command 分派至規則指定的 `project_path`。
- 驗收流程唯一允許的目標專案 Git 寫入，是由 `src/approvalGitIdentity.js` 暫時執行 `git config --local user.name` 並在 Codex 結束、失敗、逾時或 worker 重啟時恢復原狀；不得由此模組執行 add、commit、push 或其他 Git 寫入。
- `src/approvalGitVerification.js` 只允許在驗收前後執行唯讀的 commit、remote 與 `ls-remote` 查詢；不得執行 add、commit、push、fetch、pull 或修改 Git 設定。驗證只確認當下遠端分支位置，不得持續監聽遠端。
- runtime 閘門不封鎖目標專案網路或 GitHub／GitLab；目標專案仍依自己的任務與權限執行。
- 不得檢查、猜測、搬移或修改目標專案的 instructions、skills、MCP 或其他 agent 工具體系。
- `skill-dispatch` 與 probe 提示詞不得硬編碼任何目標 skill 目錄。
- 除非使用者明確把目標專案納入範圍，否則不得修改 element-bot repository 以外的目標專案。

## 開發與驗證

- 行為變更遵守 TDD：先新增會因缺少功能而失敗的測試，再寫最小實作。
- 完整測試：`npm test`
- 真實 Codex smoke test：`npm run test:codex-smoke`
- 完成前執行 `git diff --check`，並確認現行 runtime source 沒有直接啟動其他 agent CLI。
- 不得讓自動測試觸發或修改正式規則指向的目標專案。
