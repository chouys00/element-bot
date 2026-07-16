"use strict";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatTaskNumber(id) {
  const raw = String(id == null ? "" : id);
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-.*-([a-z0-9]+)$/i
  );
  if (!match) return raw;

  const [, year, month, day, hour, minute, second, millisecond, suffix] = match;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond)
  );
  const local = new Date(utc + SHANGHAI_OFFSET_MS);
  const date = [
    local.getUTCFullYear(),
    pad(local.getUTCMonth() + 1),
    pad(local.getUTCDate()),
  ].join("");
  const time = [
    pad(local.getUTCHours()),
    pad(local.getUTCMinutes()),
    pad(local.getUTCSeconds()),
  ].join("");

  return `${date}-${time}-${suffix}`;
}

module.exports = { formatTaskNumber };
