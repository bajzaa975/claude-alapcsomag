'use strict';
// The session status records (spec §6.5 "status record contract"): <dir>/<session_id>.event.json,
// .line.json and .artifacts.jsonl, read by the claude-orchestrator workbench. Nothing here throws:
// every function returns false/0 on any failure. A file name is <SAFE_ID>.<suffix>, anything else is
// refused, so a session id can never leave the dir. Whole-file writes are atomic as in lib/bridge.js
// (random tmp name opened 'wx' + rename); appendLine is a plain O_APPEND of one line.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;                       // the same rule as lib/bridge.js
const NAME = /^[A-Za-z0-9_-]{1,128}(?:\.[a-z]+)+$/;
// What prune may delete: the three record files and a tmp file a killed writeJson left behind.
const PRUNABLE = /^[A-Za-z0-9_-]{1,128}\.(?:event\.json|line\.json|artifacts\.jsonl)(?:\.\d+\.[0-9a-f]+\.tmp)?$/;

function statusDir(env = process.env) {
  return env.BAJZI_STATUS_DIR || path.join(env.BAJZI_HOME || os.homedir(), '.claude', 'bajzi', 'sessions');
}

function target(dir, name) {
  if (typeof name !== 'string' || !NAME.test(name)) return null;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function writeJson(dir, name, obj) {
  let tmp = null;
  let created = false;
  try {
    const p = target(dir, name);
    if (!p) return false;
    tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { flag: 'wx' });
    created = true;
    fs.renameSync(tmp, p);
    return true;
  } catch {
    // Only a tmp file this call created is removed: a 'wx' collision never deletes someone else's.
    if (created) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
    return false;
  }
}

function appendLine(dir, name, obj) {
  try {
    const p = target(dir, name);
    if (!p) return false;
    fs.appendFileSync(p, JSON.stringify(obj) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Deletes the record files (PRUNABLE, regular files only, symlinks never followed) whose mtime is
// more than maxAgeMs before nowMs. Returns how many were deleted.
function prune(dir, maxAgeMs, nowMs) {
  let n = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!PRUNABLE.test(name)) continue;
    try {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isFile() && nowMs - st.mtimeMs > maxAgeMs) { fs.unlinkSync(p); n++; }
    } catch { /* vanished or locked: the next SessionStart retries */ }
  }
  return n;
}

module.exports = { SAFE_ID, statusDir, writeJson, appendLine, prune };
