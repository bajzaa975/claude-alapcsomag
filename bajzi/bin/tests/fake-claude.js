'use strict';
// Stands in for the "claude" binary: CC_CLAUDE_BIN = node, CC_CLAUDE_PREFIX_ARGS = [this file].
const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CC_WORKER_MODE', 'CC_ROUTER_WORKER', 'CLAUDECODE'];
const out = {}; for (const k of keys) if (process.env[k] !== undefined) out[k] = process.env[k];
process.stdout.write('FAKE_CLAUDE ' + JSON.stringify({ env: out, argv: process.argv.slice(2) }) + '\n');
process.exit(0);
