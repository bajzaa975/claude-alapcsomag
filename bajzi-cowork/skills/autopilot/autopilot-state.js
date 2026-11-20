#!/usr/bin/env node
// autopilot-state.js on|off|status: the per-session autopilot marker the autopilot-guard hook reads.
// Also shipped in the hook-less cowork plugin: the lib is required lazily and its absence is not an error.
const fs = require('fs');
const path = require('path');
const arg = process.argv[2];
if (!['on', 'off', 'status'].includes(arg)) { console.error('usage: autopilot-state.js on|off|status'); process.exit(2); }
let L;
try { L = require('../../hooks/node/lib/autopilot'); } catch { console.log('autopilot: no bajzi hooks in this install; nothing to mark'); process.exit(0); }
const env = process.env;
const sessionId = env.CLAUDE_CODE_SESSION_ID;
const p = L.markerPath({ env, sessionId });
if (!p) { console.log('autopilot: no session key (ORCH_BUS_PANE / CLAUDE_CODE_SESSION_ID unset); no marker written'); process.exit(0); }
if (arg === 'on') {
  const key = path.basename(p).slice('autopilot-'.length, -'.json'.length);
  let ok = false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    ok = require('../../hooks/node/lib/session-status').writeJson(path.dirname(p), path.basename(p), { v: 1, key, session_id: sessionId || null, started: new Date().toISOString(), cwd: process.cwd() }) !== false;
  } catch { /* reported below */ }
  if (!ok) { console.error(`autopilot: FAILED to write the marker (${p}); the autopilot guard is NOT active`); process.exit(1); }
  console.log(`autopilot: on (${p})`);
} else if (arg === 'off') {
  try { fs.unlinkSync(p); } catch { /* missing is fine */ }
  console.log('autopilot: off');
} else {
  const on = L.isOn({ env, sessionId });
  if (!on && fs.existsSync(p)) console.log(`autopilot: off (stale marker: ${p}; clear it with: node ${__filename} off)`);
  else console.log(`autopilot: ${on ? 'on' : 'off'} (${p})`);
}
