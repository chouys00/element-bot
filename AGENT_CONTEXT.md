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

## 不在範圍內

- 不含加密媒體的實際內容(只有檔名)。
- 不含歷史訊息(裝置建立前的訊息)。
- 不含已編輯 / 撤回的關聯處理(目前每則 edit/redaction 也只是各自一行原始事件,尚未合併)。
