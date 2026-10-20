'use strict';
// PostToolUse nudge for whole-file Reads of large code files (spec §6.20). Reminds once per file
// per session of cheaper routes. NEVER blocks. Fails open.
const os = require('node:os');
const path = require('node:path');
const { readInput, addContext, runHook } = require('./lib/hook-io');
let readSeen, writeSeen, collectText, safeId;
function loadLibs() {
  ({ readSeen, writeSeen } = require('./security-patterns'));
  ({ collectText } = require('./injection-scan'));
  ({ safeId } = require('./lib/bridge'));
}

const CODE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|py|sh|ps1|go|rs|java|cs|rb|php|c|h|cpp|hpp|kt|swift|lua|sql)$/i;
const MAX_LINES = 300;

function decide(input, dir = os.tmpdir()) {
  if (!input || input.tool_name !== 'Read') return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const file = ti.file_path;
  if (typeof file !== 'string' || ti.offset != null || ti.limit != null) return null;
  if (!CODE_EXT.test(file) || /(?:^|\W)runtime\Wbriefs\W/.test(file) || !safeId(input.session_id)) return null;
  const resp = input.tool_response !== undefined ? input.tool_response : input.tool_output;
  const n = collectText(resp).replace(/\n+$/, '').split('\n').length;
  if (n <= MAX_LINES) return null;
  const p = path.join(dir, `bajzi-readnudge-${input.session_id}.json`);
  const seen = readSeen(p);
  if (seen.has(file)) return null;
  seen.add(file);
  writeSeen(p, seen);
  const name = file.replace(/\s+/g, ' ').slice(0, 200);
  return `[bajzi:read-nudge] ${name} was read whole (${n} lines). Cheaper next time: token-savior find_symbol / get_function_source, \`rtk read -l aggressive\`, or a sub-agent for whole-file reads.`;
}

// null or {kind:'context', text}. May throw: callers fail open.
function check(input) {
  loadLibs();
  const text = decide(input);
  return text ? { kind: 'context', text } : null;
}

function main() {
  runHook('read-nudge', () => {
    const d = check(readInput());
    if (d) addContext('PostToolUse', d.text);
  });
}

if (require.main === module) main(); else loadLibs();

module.exports = { check, decide, MAX_LINES };
