"use strict";

const BOT_GENERATED_KEY = "io.element_bot.generated";

function makeBotMessageContent(text) {
  return {
    msgtype: "m.text",
    body: String(text == null ? "" : text),
    [BOT_GENERATED_KEY]: true,
  };
}

// 純函式:決定一則(已解密的)事件要不要擷取。抽出來方便單元測試。
// event 為正規化後的純物件(加密房間中 content 已是解密後明文)。
// 不以 sender 過濾，讓同帳號真人訊息仍可觸發；只略過 bot 自己加上標記的系統訊息。
function shouldCapture(roomId, event, { roomIds, startTs }) {
  if (!roomIds.includes(roomId)) return false;
  if (!event || event.type !== "m.room.message") return false;
  if (!event.content || typeof event.content.body !== "string") return false;
  if (event.content[BOT_GENERATED_KEY] === true) return false;
  // 略過 initial sync 拉回來的舊訊息,只要啟動後的新訊息。
  if (typeof event.origin_server_ts === "number" && event.origin_server_ts < startTs) {
    return false;
  }
  return true;
}

// 把事件整理成要寫出的精簡記錄。
function toRecord(roomId, event) {
  return {
    event_id: event.event_id,
    room_id: roomId,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    type: event.type,
    msgtype: event.content && event.content.msgtype,
    body: event.content && event.content.body,
  };
}

module.exports = {
  BOT_GENERATED_KEY,
  makeBotMessageContent,
  shouldCapture,
  toRecord,
};
