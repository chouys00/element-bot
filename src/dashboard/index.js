"use strict";
const { loadDashboardConfig } = require("../config");
const { createServer } = require("./server");

const config = loadDashboardConfig();
const server = createServer({
  queueDir: config.queueDir,
  storageDir: config.storageDir,
  outputFile: config.outputFile,
});
server.listen(config.dashboardPort, "127.0.0.1", () => {
  console.log(`[dashboard] 監控台已啟動 → http://127.0.0.1:${config.dashboardPort}`);
});
