'use strict';
// PostToolUse check for Edit|Write|MultiEdit|NotebookEdit: reminds Claude of likely security
// mistakes in the NEW text (spec §6.19). Never blocks, no LLM call, fails open. Each rule fires
// once per session per file (state: <tmpdir>/bajzi-secpat-<session_id>.json, like the context guard).
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { readInput, addContext, runHook } = require('./lib/hook-io');
let scanText, safeId;
function loadLibs() { ({ scanText } = require('./lib/security-rules')); ({ safeId } = require('./lib/bridge')); }

const SCANNED = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

function newText(ti) {
  const parts = [ti.new_string, ti.content, ti.new_source];
  if (Array.isArray(ti.edits)) for (const e of ti.edits) parts.push(e && e.new_string);
  return parts.filter(s => typeof s === 'string').join('\n');
}

function readSeen(p) {
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf8')).seen); } catch (e) {
    if (e && e.code === 'ENOENT') return new Set();
    throw e; // unreadable state: the caller fails open
  }
}

function writeSeen(p, seen) {
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ seen: [...seen] }), { flag: 'wx' });
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  } // a failed state write only loses dedup; the reminder is still returned
}

function decide(input, dir = os.tmpdir()) {
  if (!input || typeof input.tool_name !== 'string' || !SCANNED.test(input.tool_name)) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const file = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : '';
  const text = newText(ti);
  if (!file || !text || !safeId(input.session_id)) return null;
  const hits = scanText(text, file);
  if (!hits.length) return null;
  const p = path.join(dir, `bajzi-secpat-${input.session_id}.json`);
  const seen = readSeen(p);
  const fresh = hits.filter(h => !seen.has(`${file}|${h.id}`));
  if (!fresh.length) return null;
  for (const h of fresh) seen.add(`${file}|${h.id}`);
  writeSeen(p, seen);
  const name = file.replace(/\s+/g, ' ').slice(0, 200);
  return [`[bajzi:security-patterns] Possible security issue in ${name} (${fresh.map(h => h.id).join(', ')}). Check before moving on:`,
    ...fresh.map(h => `- ${h.id}: ${h.msg}`)].join('\n');
}

// null or {kind:'context', text}. May throw: callers fail open.
function check(input) {
  loadLibs();
  const text = decide(input);
  return text ? { kind: 'context', text } : null;
}

function main() {
  runHook('security-patterns', () => {
    const d = check(readInput());
    if (d) addContext('PostToolUse', d.text);
  });
}

if (require.main === module) main(); else loadLibs();

module.exports = { check, decide, newText, SCANNED, readSeen, writeSeen };
