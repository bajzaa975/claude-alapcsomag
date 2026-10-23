#!/usr/bin/env node
// Prints the repo-relative path autopilot writes decision notes to.
// Untracked path while an external night run holds the repo (runtime/nightrun/.lock)
// and this session is not the run's own (BAJZI_NIGHT_RUN !== '1'). Never throws.
const fs = require('fs');
const path = require('path');
const TRACKED = 'runtime/DECISIONS.md';
const UNTRACKED = 'runtime/handoff/autopilot-decisions.md';
function decisionLogPath(root, env = process.env) {
  if (env.BAJZI_NIGHT_RUN === '1') return TRACKED;
  try {
    fs.statSync(path.join(root, 'runtime', 'nightrun', '.lock'));
    return UNTRACKED;
  } catch (e) {
    return e && e.code === 'ENOENT' ? TRACKED : UNTRACKED; // unreadable/odd error: fail safe
  }
}
module.exports = { decisionLogPath };
if (require.main === module) {
  let out = UNTRACKED;
  try { out = decisionLogPath(path.resolve(process.argv[2] || process.cwd())); } catch (e) { /* fail safe */ }
  console.log(out);
}
