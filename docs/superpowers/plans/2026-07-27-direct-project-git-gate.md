# 直接專案路徑與 Git 起跑閘門實作計畫

**目標：** 恢復直接在規則指定的 `project_path` 執行任務，移除每筆任務建立 worktree 的流程，同時用唯讀 Git 起跑閘門避免覆蓋既有未提交修改。

## 實作順序

1. 先新增 Git 起跑閘門與單筆輪詢的失敗測試。
2. 實作唯讀 Git 檢查：路徑、repository、目前分支、工作樹狀態。
3. 將 worker 改為每次只處理排序後第一筆 pending；不符合起跑條件時保留 pending 並停止本輪。
4. 將任務提示詞改為直接在 `project_path` 工作，驗收前禁止 commit/push。
5. 將 Dashboard 驗收事件與發布 executor 改為使用 `project_path`，保留既有 outbox、重試、復原與冪等機制。
6. 更新現行文件、單元／整合／真實 Codex smoke 測試。
7. 執行完整驗證後重啟 bot、worker、dashboard，確認服務與 Dashboard 狀態。
