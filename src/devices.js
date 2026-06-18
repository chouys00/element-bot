"use strict";
// 刪除同名(element-bot)且非當前的舊裝置,避免每次新登入造成裝置清單膨脹。
// 刪除裝置需要 UIA(密碼）。失敗不致命,僅警告。
async function pruneOldDevices(client, { deviceName, currentDeviceId, userId, password }) {
  let list;
  try {
    list = await client.getDevices();
  } catch (e) {
    console.warn("[devices] 取得裝置清單失敗,略過清理:", e.message);
    return;
  }
  const targets = (list.devices || [])
    .filter((d) => d.display_name === deviceName && d.device_id !== currentDeviceId)
    .map((d) => d.device_id);
  if (targets.length === 0) return;

  try {
    await client.deleteMultipleDevices(targets, {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password,
    });
    console.log(`[devices] 已清除 ${targets.length} 個舊的 ${deviceName} 裝置`);
  } catch (e) {
    console.warn("[devices] 清除舊裝置失敗（不影響運作）:", e.message);
  }
}
module.exports = { pruneOldDevices };
