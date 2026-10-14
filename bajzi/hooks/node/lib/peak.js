'use strict';
// Z.ai GLM peak window: 14:00-18:00 UTC+8 = 06:00-10:00 UTC, every day (3x quota inside).
// Computed in UTC so the local clock change (CEST/CET) never moves it.
const START_H = 6;
const END_H = 10;
const DAY_MS = 86400000;

function peakStatus(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = dayStart + START_H * 3600000;
  const end = dayStart + END_H * 3600000;
  if (nowMs >= start && nowMs < end) {
    return { inPeak: true, minsToStart: null, minsToEnd: Math.ceil((end - nowMs) / 60000) };
  }
  const next = nowMs < start ? start : start + DAY_MS;
  return { inPeak: false, minsToStart: Math.ceil((next - nowMs) / 60000), minsToEnd: null };
}

module.exports = { peakStatus };
