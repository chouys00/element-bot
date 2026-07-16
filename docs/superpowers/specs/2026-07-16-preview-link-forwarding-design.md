# 第一階段驗收連結轉交設計

## 目標

任務專案只要在 Codex 既有的通用 `status + output` 最終回覆中放入 `http` 或 `https` URL，element-bot 就保存 URL、在 Dashboard 顯示為可點擊連結，並在 Matrix 通知中優先列出。

## 範圍

- 不新增 preview 專用結果欄位，不改動 `status + output` 契約。
- 不啟動、停止、健康檢查或保存 preview process。
- 不託管任務專案的截圖、錄影或 build 檔案；任務專案回傳的 URL 必須已可存取。
- 只接受可解析的 `http:` 與 `https:` URL。

## 資料流程

1. 任務專案在 output 寫入可驗收資源 URL。
2. worker 依既有流程保存完整 output。
3. `parseProgress()` 擷取安全 URL 並回傳給 Dashboard。
4. Dashboard 保持 output 為純文字，另以安全 anchor 顯示「相關連結」。
5. 通知檔保存 URL，Matrix 通知在摘要前列出連結。

## 安全規則

- URL 以標準 `URL` parser 驗證 protocol。
- Dashboard 的 href 與顯示文字都經 escape；anchor 使用 `target="_blank"`、`rel="noopener noreferrer"`。
- output 不得作為 HTML 或 Markdown HTML 插入。

## 後續範圍

多任務 snapshot、固定 URL、TTL 與 preview 回收屬第二階段 Preview Manager，不在本階段處理。
