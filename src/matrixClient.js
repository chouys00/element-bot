"use strict";
// 提供 IndexedDB 全域(Node 安全網;記憶體版 crypto 通常不需要,但有些路徑會引用)。
require("fake-indexeddb/auto");
const sdk = require("matrix-js-sdk");
const { decodeRecoveryKey } = require("matrix-js-sdk/lib/crypto-api/recovery-key");

// 用帳密做「全新裝置」登入,回傳 { userId, deviceId, accessToken }。
async function loginNewDevice({ homeserver, userId, password, deviceName }) {
  const tmp = sdk.createClient({ baseUrl: homeserver });
  const res = await tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user: userId },
    password,
    initial_device_display_name: deviceName,
  });
  return { userId: res.user_id, deviceId: res.device_id, accessToken: res.access_token };
}

// 用登入結果建立一個啟用 Rust crypto(記憶體)的 client。
// getSecretStorageKey callback 必須在 createClient 時就傳入(事後賦值無效),
// 它在 SDK 需要 4S 金鑰時回傳 [keyId, 由 recovery key 解出的 ssKey]。
async function buildCryptoClient({ homeserver, session, recoveryKey }) {
  const ssKey = decodeRecoveryKey(recoveryKey); // Uint8Array
  const client = sdk.createClient({
    baseUrl: homeserver,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        const keyId = Object.keys(keys)[0];
        if (!keyId) return null;
        return [keyId, ssKey];
      },
    },
  });
  // useIndexedDB:false → 記憶體 crypto store(不落地,符合本架構)。
  await client.initRustCrypto({ useIndexedDB: false });
  return client;
}

module.exports = { loginNewDevice, buildCryptoClient };
