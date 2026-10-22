'use strict';
// Tired mode, SessionStart: after an automatic compaction (source `compact`) with the session's
// <statusDir>/<id>.tired file present, re-injects the tired skill's `## Rules`; any other source
// deletes the file. Fail-open: exit 0, prints nothing on any error.
const fs = require('node:fs');
const path = require('node:path');
const { readInput, runHook, addContext } = require('./lib/hook-io');

function main() {
  const input = readInput();
  const ss = require('./lib/session-status');
  const id = input && input.session_id;
  if (typeof id !== 'string' || !ss.SAFE_ID.test(id)) return;
  const f = path.join(ss.statusDir(process.env), `${id}.tired`);
  if (input.source !== 'compact') { try { fs.unlinkSync(f); } catch { /* none */ } return; }
  if (!fs.existsSync(f)) return;
  const md = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'tired', 'SKILL.md'), 'utf8');
  const m = /^## Rules[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(md);
  if (!m) return;
  addContext('SessionStart', `Tired mode is ON for this session. Follow these rules:\n## Rules\n${m[1].trim()}`);
}

if (require.main === module) runHook('tired', main);
