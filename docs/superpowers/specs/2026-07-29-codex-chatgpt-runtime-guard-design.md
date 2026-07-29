# Codex ChatGPT Runtime 安全閘門設計

## 目標

element-bot 唯一允許使用的 agent runtime 是該裝置已安裝、已使用 ChatGPT 帳號登入的 OpenAI Codex。所有判斷、探測與任務執行都必須消耗該登入帳號的 Codex 額度；不得啟動 Cursor、Claude、Gemini、Aider 或其他 agent，也不得以 API Key、自訂 provider 或不明認證方式執行 Codex。

這項安全閘門只限制 element-bot 選用的 agent runtime，不封鎖一般網路、不掃描目標專案的 `.env` 或 API 設定，也不影響目標專案依自身規則執行 GitHub／GitLab 推送。

## 現況與缺口

現行 `src/codexRunner.js` 是唯一允許建構 Codex CLI 參數及啟動 agent 的模組，其他模組只呼叫 `runCodex()`；`test/runtimeMigration.test.js` 會檢查正式程式沒有從其他位置啟動 agent CLI。

runner 目前使用 `CODEX_COMMAND`，未設定時交由系統 `PATH` 解析 `codex`，隨後直接執行 `codex exec`。它尚未確認：

- 解析到的程式是否真的是 OpenAI Codex；
- Codex 是否使用 ChatGPT 帳號登入；
- 實際執行與驗證是否使用同一個檔案；
- 使用者設定是否把內建 OpenAI provider 改到自訂或代理服務；
- 驗證失敗時是否明確拒絕其他 agent fallback。

## 核心安全契約

1. 唯一允許的 agent runtime 是 OpenAI Codex CLI。
2. Codex 必須以 `codex login status` 明確回報 `Logged in using ChatGPT`。
3. API Key 登入、未登入、狀態不明或檢查失敗，一律在模型呼叫前中止。
4. 執行時固定使用 Codex 內建 `openai` provider；偵測到會改變模型服務來源的使用者層 provider 或 base URL 設定時中止。
5. 找不到合格 Codex 時不得改用 Cursor、Claude 或任何其他 agent。
6. 驗證與執行必須使用同一個已解析的絕對執行檔路徑。
7. 登入與身分檢查本身不得呼叫模型或消耗 Codex 額度。
8. 網路、目標專案憑證與外部 API 不屬於此閘門範圍；現有 Git 發布流程維持不變。

## 執行檔解析與身分驗證

`src/codexRunner.js` 集中提供 runtime preflight。解析順序維持相容性：

1. 若 `CODEX_COMMAND` 有值，將它解析成絕對路徑。
2. 否則從目前程序的 `PATH` 尋找 `codex`。
3. 解析失敗、結果不是一般檔案或仍不是絕對路徑時中止。

Windows 必須符合下列條件：

- 執行檔副檔名是 `.exe`，不得使用 `.cmd`、`.bat`、`.ps1`、shell alias 或其他 wrapper；
- Authenticode 簽章狀態是 `Valid`；
- 簽署者主體包含 `OpenAI OpCo, LLC`；
- 使用該絕對路徑執行 `--version`，輸出必須包含 `codex-cli`。

非 Windows 平台仍須解析成實體絕對路徑並以 `--version` 驗證 `codex-cli`。若平台能可靠取得官方程式簽章，後續可在不改變公開契約的前提下增加同等驗證；本次不假設不存在的跨平台簽章介面。

執行檔身分驗證在程序生命週期內快取，並記錄路徑、檔案大小與修改時間。每次呼叫前重新取得檔案資訊；任何一項改變就重新完成簽章與版本驗證，避免每筆判斷都承受數位簽章驗證延遲，同時防止程序運行期間替換執行檔。

## ChatGPT 登入與 provider 驗證

每次 `runCodex()` 真正啟動模型前，都以同一個已驗證的絕對路徑執行：

```text
codex login status
```

只接受 stdout 中獨立一行完全等於 `Logged in using ChatGPT`。stderr 的一般警告可保留作診斷，但不得代替成功條件。下列結果全部拒絕：

- API Key 登入；
- 未登入；
- 找不到成功文字；
- timeout、非零 exit code 或無法啟動；
- 輸出同時含有互相矛盾的登入資訊。

執行 `codex exec` 時以命令列設定固定 `model_provider="openai"`。此外，runtime preflight 逐行檢查使用者層 `~/.codex/config.toml`，先忽略空白行與第一個非空白字元為 `#` 的註解，再套用下列固定規則：

- `model_provider` 未設定或明確等於 `openai` 才能通過；
- 出現 `openai_base_url` 或 `chatgpt_base_url` 就中止；
- 出現頂層 `profile` 選擇或任何 `[profiles.*]` 區段就中止，避免 profile 間接改變 provider 或 base URL；
- 僅宣告但未選用的 `[model_providers.*]` 可以保留，因命令列仍固定選擇內建 `openai`。

目標專案內的 `.codex/config.toml` 不由 element-bot 掃描或修改，且 Codex 本身不允許專案層設定覆寫 provider 與 base URL。

不清除或修改電腦上的任何 API Key。安全性來自「驗證登入方式、固定 provider、拒絕不明來源」，而不是掃描所有工具的金鑰。

## 啟動時與執行時行為

- bot 與 worker 啟動時呼叫 runner 提供的唯讀 preflight，讓部署錯誤盡早出現在日誌與 Dashboard 狀態。
- 每次 judge、probe、execute 與 approval 執行前再次檢查 ChatGPT 登入，避免服務啟動後登入方式被切換。
- 身分或登入檢查失敗時不得啟動 `codex exec`，也不得增加任何模型用量。
- 服務可保留 Dashboard 與 Matrix 的基本狀態呈現能力，但受影響任務必須以明確的 runtime blocked 原因停止，不得靜默重試造成日誌洗版。

錯誤訊息至少包含：

- 已解析的執行檔路徑；若尚未解析則說明尋找來源；
- 失敗階段：解析、簽章、版本、設定或登入；
- 偵測到的登入類型，但不得包含 token、認證內容或 `.env` 機密；
- 修正方式：開啟 Codex App／CLI，以 ChatGPT 帳號登入後重試。

## 邊界與相容性

- `src/codexRunner.js` 仍是唯一知道 Codex CLI 參數與啟動方式的模組。
- 其他正式模組只能呼叫 runner 匯出的 preflight 或 `runCodex()`，不得自行解析或啟動任何 agent。
- `CODEX_COMMAND` 繼續支援新機器部署與 Codex App bundled executable，但設定值仍須通過同一套身分驗證。
- judge、probe、execute 的 sandbox、network、timeout、output schema 與 Windows process-tree cleanup 行為不因本功能改變。
- 不新增 Cursor、Claude 或其他 runtime 的相容層或 fallback。
- 不檢查、猜測、搬移或修改目標專案的 instructions、skills、MCP、`.env` 或其他工具設定。

## 測試與驗證

行為變更遵守 TDD，先建立會因缺少安全閘門而失敗的測試，再實作最小功能。測試至少涵蓋：

- `CODEX_COMMAND` 與 `PATH` 都解析到絕對路徑，且驗證與執行使用同一路徑；
- Windows 拒絕 wrapper、無效簽章、非 OpenAI 簽署者與非 `codex-cli` 程式；
- 接受 ChatGPT 登入，拒絕 API Key、未登入、矛盾輸出、timeout 與非零 exit code；
- 固定使用內建 `openai` provider，拒絕會改變 provider／base URL 的使用者層設定；
- 驗證失敗時 `codex exec` 完全沒有被啟動；
- 執行檔資訊未變時使用身分快取，資訊變更時重新驗證；
- runtime 靜態邊界仍只允許 `src/codexRunner.js` 啟動 agent CLI；
- 現有 judge、probe、execute、output schema 與 timeout 行為不變。

完成前執行：

- 新增的精準單元測試，並確認 red／green；
- `npm test`；
- `npm run test:codex-smoke`，只在使用者明確同意消耗該 ChatGPT 帳號 Codex 額度後執行；
- `git diff --check`；
- runtime 邊界掃描，確認沒有 Cursor、Claude 或其他 agent 啟動路徑。

## 非目標

- 不封鎖一般網路或 GitHub／GitLab；
- 不判斷目標專案呼叫的外部 API 是否收費；
- 不掃描或刪除任何 API Key；
- 不管理 ChatGPT 方案、剩餘額度或加購 credits；
- 不自動登入、登出、切換帳號或複製 Codex 認證檔；
- 不修改目標專案。
