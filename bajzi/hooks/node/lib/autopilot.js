'use strict';
// Autopilot marker: <statusDir>/autopilot-<key>.json, key = ORCH_BUS_PANE else session id (SAFE_ID only).
// Nothing here throws. isOn = night-run env or the marker file for this key.
const fs = require('node:fs');
const path = require('node:path');
const { SAFE_ID, statusDir } = require('./session-status');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function markerPath({ env = process.env, sessionId } = {}) {
  try {
    const pane = env && env.ORCH_BUS_PANE;
    const key = pane ? String(pane) : (typeof sessionId === 'string' ? sessionId : '');
    if (!SAFE_ID.test(key)) return null;
    return path.join(statusDir(env), `autopilot-${key}.json`);
  } catch { return null; }
}

function isOn({ env = process.env, sessionId } = {}) {
  try {
    if (env && env.BAJZI_NIGHT_RUN === '1') return true;
    const p = markerPath({ env, sessionId });
    if (!p || !fs.existsSync(p)) return false;
    const t = Date.parse(JSON.parse(fs.readFileSync(p, 'utf8')).started);
    return Number.isFinite(t) && Date.now() - t <= MAX_AGE_MS;
  } catch { return false; }
}

module.exports = { markerPath, isOn, MAX_AGE_MS };
