"use strict";

// 純函式:決定一則(已解密的)事件要不要擷取。抽出來方便單元測試。
// event 為正規化後的純物件(加密房間中 content 已是解密後明文)。
// 注意:不過濾 sender —— bot 登入的就是使用者本人帳號且從不發訊息,
// 本人在受監聽房間的發言本就應收錄。
function shouldCapture(roomId, event, { roomIds, startTs }) {
  if (!roomIds.includes(roomId)) return false;
  if (!event || event.type !== "m.room.message") return false;
  if (!event.content || typeof event.content.body !== "string") return false;
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

module.exports = { shouldCapture, toRecord };
