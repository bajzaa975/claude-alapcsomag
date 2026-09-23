'use strict';
// The status line -> context guard bridge: <tmpdir>/bajzi-ctx-<session_id>.json = {used_pct, ts}.
// session_id becomes part of a file name, so it must match SAFE_ID; anything else = no bridge
// at all (never written, never read). Writes are atomic: tmp file in the same dir + rename.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FUTURE_TOLERANCE_MS = 5000;

function safeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id);
}

function bridgePath(sessionId, dir = os.tmpdir()) {
  return safeId(sessionId) ? path.join(dir, `bajzi-ctx-${sessionId}.json`) : null;
}

function warnPath(sessionId, dir = os.tmpdir()) {
  return safeId(sessionId) ? path.join(dir, `bajzi-ctx-${sessionId}-warned.json`) : null;
}

function writeBridge(sessionId, usedPct, nowMs = Date.now(), dir = os.tmpdir()) {
  const p = bridgePath(sessionId, dir);
  if (!p || typeof usedPct !== 'number' || !Number.isFinite(usedPct)) return false;
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ used_pct: usedPct, ts: nowMs }));
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

function readBridge(sessionId, nowMs = Date.now(), staleSec = 60, dir = os.tmpdir()) {
  const p = bridgePath(sessionId, dir);
  if (!p) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  if (!j || typeof j.used_pct !== 'number' || !Number.isFinite(j.used_pct) || typeof j.ts !== 'number') return null;
  const age = nowMs - j.ts;
  if (age > staleSec * 1000 || age < -FUTURE_TOLERANCE_MS) return null;
  return j.used_pct;
}

module.exports = { safeId, bridgePath, warnPath, writeBridge, readBridge };
