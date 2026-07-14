# element-bot repository instructions

## 溝通語言

- 任務對話、回覆、設計文件與實作計畫一律使用繁體中文。
- 程式識別字、CLI 指令、環境變數與必要技術名詞維持原文。

## Agent runtime 邊界

- Codex 是唯一支援的 agent runtime。
- 只有 `src/codexRunner.js` 可以建構 Codex CLI 參數或啟動 `codex`。
- 其他模組只能呼叫 `runCodex()`、`runCodexSync()`，不得直接使用 `child_process` 啟動 agent CLI。
- 未來若更換 provider，只修改 runner、直接呼叫介面、相關單元測試與現行操作文件；不得對整個 repository 做機械式全域取代。
- 歷史 `docs/superpowers/` 與 `CHANGELOG.md` 應保留當時實際使用的工具名稱。

## 分派器責任

- element-bot 只負責監聽 Matrix、判斷與擷取訊息、排入 queue，以及把 command 分派至規則指定的 `project_path`。
- 不得檢查、猜測、搬移或修改目標專案的 instructions、skills、MCP 或其他 agent 工具體系。
- `skill-dispatch` 與 probe 提示詞不得硬編碼任何目標 skill 目錄。
- 除非使用者明確把目標專案納入範圍，否則不得修改 element-bot repository 以外的目標專案。

## 開發與驗證

- 行為變更遵守 TDD：先新增會因缺少功能而失敗的測試，再寫最小實作。
- 完整測試：`npm test`
- 真實 Codex smoke test：`npm run test:codex-smoke`
- 完成前執行 `git diff --check`，並確認現行 runtime source 沒有直接啟動其他 agent CLI。
- 不得讓自動測試觸發或修改正式規則指向的目標專案。
