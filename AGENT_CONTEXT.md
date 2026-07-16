# AGENT_CONTEXT — 給下游 AI agent 的資料說明

這份文件描述 `element-bot` 產出的資料,讓後續的 AI agent 能正確理解與消費。

## 這是什麼

`element-bot` 即時監聽公司 Element/Matrix 上指定聊天室的**新訊息**,將 E2EE 加密訊息**解密後**,逐則寫入一個 **JSONL** 檔。每則訊息一行,append-only(只新增、不修改既有行)。

- 輸出檔:`output/messages.jsonl`
- 編碼:UTF-8
- 範圍:**只有 bot 啟動之後送出的新訊息**;不含歷史訊息。
- 來源帳號:`@patrick.zyx:ims.opscloud.info` 的一個專屬監聽裝置。

## 每行的資料結構

每一行是一個獨立的 JSON 物件:

```json
{
  "event_id": "$abc123...",
  "room_id": "!jOuxmbWVxsEbbcByqa:ims.opscloud.info",
  "sender": "@alice:ims.opscloud.info",
  "origin_server_ts": 1718694123456,
  "type": "m.room.message",
  "msgtype": "m.text",
  "body": "明天的會議改到下午三點",
  "_received_at": "2026-06-18T10:30:00.000Z"
}
```

### 欄位說明

| 欄位 | 型別 | 意義 |
|------|------|------|
| `event_id` | string | Matrix 事件唯一 ID,可用來去重 |
| `room_id` | string | 訊息所屬聊天室 |
| `sender` | string | 發送者的 Matrix user ID |
| `origin_server_ts` | number | 伺服器端訊息時間(Unix 毫秒) |
| `type` | string | 一律為 `m.room.message` |
| `msgtype` | string | 訊息子型別:`m.text`(文字)、`m.notice`、`m.emote`、`m.image`/`m.file`(媒體,`body` 為檔名)等 |
| `body` | string | **訊息明文內容**(已解密)。分析時主要看這個欄位 |
| `_received_at` | string | bot 接收並寫入的本機時間(ISO 8601) |

## 消費建議

- **逐行讀取**(JSONL,不是單一 JSON 陣列);每行 `JSON.parse`。
- **以 `event_id` 去重**,避免重複處理(理論上不會重複,但保險)。
- **以 `origin_server_ts` 排序**判斷時間先後。
- 目前只保證 `m.text` 類文字內容適合直接分析;媒體類(`m.image` 等)的 `body` 只是檔名,沒有實際內容。
- 檔案會持續增長且 append-only;若要做串流處理,可只讀取新增的尾段(記住上次讀到的行數 / 位元組位移)。

## 相關檔案(v1.5+)

除了 `output/messages.jsonl`,系統還維護以下檔案(消費訊息資料時通常不需要,但除錯/整合時有用):

| 檔案 | 說明 |
|------|------|
| `config/rules.json` | 觸發規則(關鍵字 → 任務)。由 dashboard 編輯、bot 熱載入。規則**不再**存於 `.env` |
| `storage/rooms-config.json` | 監聽房間清單(權威來源)。`.env` 的 `MATRIX_ROOM_IDS` 只在此檔不存在時作後備 |
| `storage/notify-config.json` | 任務完成通知設定(是否通知、發到哪個房間) |
| `storage/rooms.json` | room_id → 房間名稱對照(bot 自動維護,供 dashboard 顯示) |
| `queue/` | 任務佇列(pending/processing/done/failed)與任務執行 log |

dashboard(`npm run dashboard`)提供任務監控、規則編輯與試跑介面。

## 驗收連結（v1.7+）

任務專案若產生可供人員驗收的資源，可在 Codex 通用結果的 `output` 以獨立的「驗收連結」區塊宣告完整 `http://` 或 `https://` URL。例如：

```json
{
  "status": "success",
  "output": "已完成前端修改。\n\n驗收連結：\n- https://preview.intra.local/tasks/task-123/"
}
```

element-bot 只解析此區塊中每行 `- URL` 的連結，並在 Dashboard 的任務詳情顯示「驗收連結」、在 Matrix 任務通知的摘要前列出 URL。任務摘要內的舊網址、新網址、禪道網址、文件網址等未宣告 URL 不會出現在驗收欄位。它只轉交連結：不會啟動、檢查、停止或託管任務專案的 preview、截圖、錄影或 build 產物。多任務 preview 的 snapshot、TTL 與回收管理屬後續 Preview Manager 範圍。

## 不在範圍內

- 不含加密媒體的實際內容(只有檔名)。
- 不含歷史訊息(裝置建立前的訊息)。
- 不含已編輯 / 撤回的關聯處理(目前每則 edit/redaction 也只是各自一行原始事件,尚未合併)。
