# 移除 Dashboard 開啟專案功能

## 目的

Element-bot 會部署於公共電腦，Dashboard 使用者不一定在該主機上。遠端按下「開啟專案」只會操作公共電腦，沒有實際用途，也不應保留遠端啟動本機檔案管理器的入口。

## 範圍

- 移除任務詳情的「開啟專案」按鈕及點擊處理。
- 移除 `/api/tasks/:id/open` API 與啟動檔案管理器的程式。
- 移除 executor summary 的 `openPath`。
- 移除 `PROJECT_ROOTS` 白名單。
- 保留任務詳情的「專案路徑」文字。
- 更新相關測試，確認前後端均無開啟入口。

## 驗證

- 執行 Dashboard、executor、task definition 相關測試。
- 執行 `npm test`、`npm run test:codex-smoke` 與 `git diff --check`。
