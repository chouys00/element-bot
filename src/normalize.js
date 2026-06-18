"use strict";
// 把 matrix-js-sdk 的 MatrixEvent 正規化成 handler 能吃的純物件。
// 注意:加密事件需在呼叫前已完成解密,getContent() 才會回傳明文。
function normalize(mxEvent) {
  return {
    event_id: mxEvent.getId(),
    room_id: mxEvent.getRoomId(),
    sender: mxEvent.getSender(),
    origin_server_ts: mxEvent.getTs(),
    type: mxEvent.getType(),
    content: mxEvent.getContent() || {},
  };
}
module.exports = { normalize };
