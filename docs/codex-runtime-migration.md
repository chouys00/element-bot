# Codex runtime 遷移與還原指南

## 現行架構

Element-bot 只支援 Codex。所有 CLI 細節集中於 `src/codexRunner.js`：

| 用途 | Codex 模式 | 權限 |
| --- | --- | --- |
| judge | `codex exec` | `read-only`、無網路 |
| probe | `codex exec` | `read-only`、無網路 |
| execute | `codex exec` | `workspace-write`、開啟網路 |

每次執行使用 `--ask-for-approval never`、`--ephemeral`、`--color never`，prompt 由 stdin 傳入。成功時 stdout 是最終回答；stderr 只作診斷，失敗時才會以限制長度附入錯誤。

Judge 另透過暫存 JSON 檔使用 `--output-schema`，執行結束後立即清除。

## 本次遷移的 live files

- CLI 邊界：`src/codexRunner.js`、`test/codexRunner.test.js`
- Judge/probe：`src/judge.js`、`src/probe.js`
- Executor：`src/executors/ops.js`、`src/executors/defaultHandlers.js`
- 任務定義：`src/taskDefs.js`
- 現行 UI 與 log 文案：`src/dashboard/`、`src/index.js`
- Repository instructions：`AGENTS.md`、`.agents/skills/`
- 設定與測試：`.env.example`、`.gitignore`、`package.json`、相關 `test/*.test.js`

## Git 邊界

本次遷移刻意拆分為可獨立檢查的 commits：

- `d30bc8e`：設計規格
- `db7c808`：實作計畫
- `ad870ae`：集中式 Codex runner
- `71d0260`：judge/probe 改用 Codex
- `3be9c08`：executor 與 target-neutral task definitions
- `86f5d9d`：現行 UI、log、設定與靜態守門測試

後續文件與 smoke-test commit 請以 `git log --oneline d30bc8e..HEAD` 查詢，不要依賴本文件中的未來 hash。

## 未來換回 Claude 的最小修改範圍

若未來確定要換回 Claude Code：

1. 先建立新分支，不要在正式分支直接修改。
2. 以 `ad870ae` 前一版的 `src/executors/ops.js`、`src/judge.js`、`src/probe.js` 作為行為參考，但不要整檔覆蓋，因為後續可能已有獨立修正。
3. 以新的單一 runner 取代 `src/codexRunner.js`；仍維持同步/非同步、timeout、stdout/stderr 與 output-schema 契約。
4. 只調整 runner 的直接呼叫介面、測試、現行 UI 文案、`.env.example` 與 repository instructions。
5. 不要恢復 `i18n-skill`、`NSL_SKILL_DIR` 或任何目標專案 skill 路徑；這些與 provider 無關，且違反分派器責任。
6. 不要全域替換 `Codex`/`Claude`。歷史 specs、plans、CHANGELOG 應保留真實歷史，目標專案也不在修改範圍。
7. 重新建立 provider 的真實 smoke test，通過後再啟動 bot、worker、dashboard 驗收。

## Claude 舊旗標對照（僅供還原研究）

| 過去 Claude Code | 現行 Codex |
| --- | --- |
| `claude -p` | `codex exec` |
| `--dangerously-skip-permissions` | 不直接對應；目前使用明確 sandbox |
| stdout 可能混合狀態資訊 | Codex final answer 在 stdout、進度在 stderr |

禁止把危險旗標做一對一字串替換。新的 provider 必須重新設計最小權限。

## 目標專案邊界

Element-bot 不知道也不應知道目標專案使用 `.agents/skills`、`.claude/skills`、`.cursor/skills` 或其他機制。它只把 command 交給以該專案為 cwd 的 agent runtime。任何目標專案遷移都必須在另一個明確授權的任務中進行。
