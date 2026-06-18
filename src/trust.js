"use strict";

// 用 recovery key 建立信任(getSecretStorageKey callback 已在 buildCryptoClient 設定):
//  0) 先強制下載自己 user 的金鑰,讓 crypto 取得既有 cross-signing 公鑰
//  1) bootstrapCrossSigning → 取出既有 cross-signing 私鑰並簽署本裝置(自我驗證)
//  2) 載入 + 啟用 key backup → SDK 之後會持續從伺服器備份下載房間金鑰
//  3) restoreKeyBackup → 立即拉一次現有金鑰
async function establishTrust(client, { userId, password }) {
  const crypto = client.getCrypto();

  // 觸發 /keys/query,否則 importCrossSigningKeys 會因「找不到 public identity」失敗。
  await crypto.userHasCrossSigningKeys(userId, true);

  const authUploadDeviceSigningKeys = async (makeRequest) => {
    await makeRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password,
    });
  };
  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });

  // key backup：載入備份金鑰、啟用持續下載、並立即還原一次
  try {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  } catch (e) {
    console.warn("[trust] 載入 backup 金鑰失敗（可能未設定 key backup）:", e.message);
  }
  await crypto.checkKeyBackupAndEnable();

  const version = await crypto.getActiveSessionBackupVersion();
  if (version) {
    try {
      const res = await crypto.restoreKeyBackup();
      console.log(`[trust] key backup 還原: 匯入 ${res.imported}/${res.total} 把金鑰`);
    } catch (e) {
      console.warn("[trust] restoreKeyBackup 失敗:", e.message);
    }
  } else {
    console.warn("[trust] 無啟用中的 key backup 版本;將僅靠裝置驗證後的直接金鑰分享。");
  }

  const ready = await crypto.isCrossSigningReady();
  console.log(`[trust] cross-signing ready = ${ready}`);
}

module.exports = { establishTrust };
