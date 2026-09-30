'use strict';
// Combined PostToolUse entry (hooks.json matcher .*): ONE node process runs every bajzi Node
// PostToolUse check in-process, each only on the tools its old hooks.json matcher covered.
// Every check fails open on its own (pre-tool.js runChecks); warnings are joined in CHECKS order
// (context first) into one additionalContext; a single warning is byte-identical to the check
// run directly. Never denies.
const { readInput, addContext, runHook } = require('./lib/hook-io');

// [name, the old hooks.json matcher as a tool-name test, loader]. The injection matcher was
// Read|WebFetch|WebSearch|mcp__.*; injection-scan.js SCANNED applies the same set again.
const CHECKS = [
  ['context-guard', () => true, () => require('./context-guard')],
  ['injection-scan', t => /^(?:Read|WebFetch|WebSearch)$|^mcp__/.test(t), () => require('./injection-scan')],
];

function main() {
  runHook('post-tool', () => {
    const { runChecks } = require('./pre-tool');
    const texts = runChecks(CHECKS, readInput()).filter(r => r.kind === 'context').map(r => r.text);
    if (texts.length) addContext('PostToolUse', texts.join('\n\n'));
  });
}

if (require.main === module) main();
