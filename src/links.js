"use strict";

function extractHttpLinks(text) {
  const matches = String(text == null ? "" : text).match(/https?:\/\/[^\s<>'"`，。；：！？]+/gi) || [];
  const links = [];
  for (const raw of matches) {
    const candidate = raw.replace(/[.,;:!?，。；：！？]+$/, "");
    try {
      const url = new URL(candidate);
      if ((url.protocol === "http:" || url.protocol === "https:") && !links.includes(url.href)) {
        links.push(url.href);
      }
    } catch (_) {}
  }
  return links;
}

// 只有任務輸出明確宣告的「驗收連結」才是可供 Dashboard 與通知轉交的證據。
// 區塊內一行一個「- URL」，遇到空行或其他文字即結束，避免把摘要中的業務網址誤判為驗收網址。
function extractAcceptanceLinks(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const links = [];
  let inAcceptanceBlock = false;

  for (const line of lines) {
    if (!inAcceptanceBlock) {
      if (/^\s*驗收連結[：:]\s*$/.test(line)) inAcceptanceBlock = true;
      continue;
    }

    const match = line.match(/^\s*[-*]\s+(https?:\/\/\S+)\s*$/i);
    if (!match) break;
    for (const url of extractHttpLinks(match[1])) {
      if (!links.includes(url)) links.push(url);
    }
  }

  return links;
}

module.exports = { extractHttpLinks, extractAcceptanceLinks };
