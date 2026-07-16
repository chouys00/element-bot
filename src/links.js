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

module.exports = { extractHttpLinks };
