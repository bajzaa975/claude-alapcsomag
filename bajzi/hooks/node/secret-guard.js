'use strict';
// PreToolUse secret-read guard for Read, Grep, Glob, Bash and PowerShell. Denies reading .env,
// .env.* (except .example/.sample/.template/.dist), .secrets and manifest.json secret_patterns.
// Pattern guard, not a shell parser (see lib/secret-rules.js). Fails open.
const path = require('node:path');
const { readInput, deny, runHook } = require('./lib/hook-io');
// Libs other than hook-io load inside runHook (F4): a partial install still fails open.
let rules;
function loadLibs() { rules = require('./lib/secret-rules'); }

function pluginRoot(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function decide(input, extra) {
  if (!input || typeof input !== 'object') return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  if (!ti) return null;
  switch (input.tool_name) {
    case 'Read':
      return rules.matchProtected(str(ti.file_path), extra);
    case 'Grep':
      return rules.matchProtected(str(ti.path), extra) || rules.matchGlobPattern(str(ti.glob), extra);
    case 'Glob':
      return rules.matchProtected(str(ti.path), extra) || rules.matchGlobPattern(str(ti.pattern), extra);
    case 'Bash':
    case 'PowerShell':
      return rules.commandReadsProtected(str(ti.command), extra, input.tool_name);
    default:
      return null;
  }
}

function reasonFor(hit, tool) {
  const b = rules.baseName(hit.path);
  const alt = hit.rule === 'env-file' ? '.env.example' : `${b}.example`;
  return `${tool} would read a protected secret file (${b}). Do not read secrets into the context; read ${alt} instead if the project has one, or ask the user for the specific non-secret value. Note: this is a pattern guard, not a shell parser.`;
}

function main() {
  runHook('secret-guard', () => {
    loadLibs();
    const input = readInput();
    if (!input) return;
    const hit = decide(input, rules.loadExtraPatterns(pluginRoot()));
    if (hit) deny(reasonFor(hit, input.tool_name), hit.rule);
  });
}

if (require.main === module) main(); else loadLibs();

module.exports = { decide, reasonFor, pluginRoot };
