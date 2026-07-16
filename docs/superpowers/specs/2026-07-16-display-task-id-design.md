# 顯示任務 ID

## 目的

沿用 element-bot 現有 queue 任務 ID，讓使用者可從 Dashboard 詳情與 Matrix 任務通知快速對照任務檔、日誌及問題回報。

## 範圍

- 任務詳情顯示完整任務 ID。
- 任務通知 payload 保存 ID，通知文字顯示完整任務 ID。
- 任務列表不新增 ID 欄位。
- 不改變 ID 生成方式。

## 驗證

- Dashboard 與通知測試先失敗再修正。
- 執行完整測試、真實 Codex smoke test與 `git diff --check`。
