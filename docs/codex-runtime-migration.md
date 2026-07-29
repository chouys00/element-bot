# Codex runtime 遷移與還原指南

## 現行架構

Element-bot 只支援 Codex。所有 CLI 細節集中於 `src/codexRunner.js`：

| 用途 | Codex 模式 | 權限 |
| --- | --- | --- |
| judge | `codex exec` | `read-only`、無網路 |
| probe | `codex exec` | `read-only`、無網路 |
| execute | `codex exec` | `danger-full-access`、開啟網路 |

每次執行使用 `--ask-for-approval never`、`--ephemeral`、`--color never`，prompt 由 stdin 傳入。成功時 stdout 是最終回答；stderr 只作診斷，失敗時才會以限制長度附入錯誤。

bot 與 worker 啟動前會先解析 Codex 的絕對路徑。Windows 只接受具有 `OpenAI OpCo, LLC`
有效數位簽章的 `codex.exe`；所有平台都必須回報 `codex-cli`，且
`codex login status` 必須明確顯示 `Logged in using ChatGPT`。API Key、未登入、自訂
provider/base URL 或不明狀態一律以 `Codex runtime blocked` 停止，不會改用其他 agent。
這些身分與登入檢查不會呼叫模型，也不消耗 Codex 額度。

Judge 另透過暫存 JSON 檔使用 `--output-schema`，執行結束後立即清除。

## 任務結果契約與還原

現行結果契約不假設 Git、commit、檔案修改或任何特定任務類型，只要求 `status` 與完整 `output`。dashboard 會把 `output` 直接顯示為「執行輸出 (Codex)」，中間不會再呼叫第二個 LLM 改寫或摘要。

Codex 應先依目標環境規則判斷工作是否已經完成。若已有足夠證據，任務可在沒有新增修改、commit 或其他 side effect 的情況下直接回報 `success`，不應為了製造變更而重複執行。

若需要恢復舊版詳細結果格式，從 Git 歷史還原結果 schema、executor、Dashboard 與相關測試；現行 runtime 不保留雙軌切換。還原 element-bot 不會修改任何目標專案檔案、instructions 或 skills。

### Windows sandbox helper 路徑

若 `codex` 可啟動、但 execute 階段回報 `orchestrator_helper_launch_failed` 或
`codex-windows-sandbox-setup.exe` 存取被拒，先執行 `npm run test:codex-smoke` 確認。
部分 standalone 安裝版本的公開 `bin/codex.exe` 無法定位套件旁的 `codex-resources`；
可在本機 `.env` 暫時把 `CODEX_COMMAND` 指向
`%USERPROFILE%\.codex\packages\standalone\releases\<version>-x86_64-pc-windows-msvc\bin\codex.exe`。
這是本機執行環境修正，不應把使用者名稱或版本路徑提交進版控；Codex 升級後應改回
`CODEX_COMMAND=codex` 並重跑 smoke test。

Windows 的 `CODEX_COMMAND` 必須解析到 `codex.exe`。本專案刻意不以 `shell:true` 執行
npm 的 `codex.cmd` shim，因為 shell timeout 可能留下仍在目標專案寫入的子程序。
若 `Get-Command codex` 只找到 `.cmd`，請安裝官方 standalone/Desktop CLI，或把
`CODEX_COMMAND` 指到具有同版 `codex-resources` 的套件內 `codex.exe`。
即使手動設定 `CODEX_COMMAND`，runner 仍會驗證同一個執行檔的簽章、版本與 ChatGPT
登入狀態，不會因為環境變數而略過安全閘門。

`judge`/`probe` 預設 timeout 為 120 秒；`execute` 讀取 `AI_TIMEOUT_MS`，預設 1,800,000
毫秒（30 分鐘）。不要把 execute 默認值縮成 judge 的短 timeout。

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

## Provider 政策

本專案的唯一 agent runtime 是以裝置 ChatGPT 帳號登入的 OpenAI Codex，不提供其他
provider、API Key、代理 base URL 或 agent fallback。runtime 不合格時只能停止並提示
修正環境，不能用另一個可能計費的服務繼續執行。

歷史規格、計畫與 `CHANGELOG.md` 仍保留當時實際使用過的工具名稱；這些歷史記錄不是
現行執行方式，也不得作為恢復其他 runtime 的操作指南。

## 目標專案邊界

Element-bot 不知道也不應知道目標專案使用 `.agents/skills`、`.claude/skills`、`.cursor/skills` 或其他機制。它只把 command 交給以該專案為 cwd 的 agent runtime。任何目標專案遷移都必須在另一個明確授權的任務中進行。

runtime 閘門只限制 element-bot 選用的 agent，不封鎖一般網路，也不掃描目標專案的
`.env`、API 設定或 Git 認證。目標專案接到任務後，仍可依自身規則向 GitHub／GitLab
推送；這不是 element-bot 額外呼叫付費 API。
