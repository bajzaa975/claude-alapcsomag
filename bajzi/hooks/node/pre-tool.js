'use strict';
// Combined PreToolUse entry (hooks.json matcher .*): ONE node process runs every bajzi Node
// PreToolUse check in-process, each only on the tools its old hooks.json matcher covered.
// Every check fails open on its own: a throw (a missing lib included) is logged under the
// check's name and never hides another check's deny. Denies are joined in CHECKS order (context
// first) into one envelope; a single deny is byte-identical to the check run directly.
const { readInput, deny, logError, runHook } = require('./lib/hook-io');

// [name, the old hooks.json matcher as a tool-name test, loader]. Loaders run inside runHook
// (F4): a missing check module is that check's failure only.
const CHECKS = [
  ['context-guard', () => true, () => require('./context-guard')],
  ['secret-guard', t => /^(?:Read|Grep|Glob|Bash|PowerShell)$/.test(t), () => require('./secret-guard')],
];

// Results of every check whose matcher covers the tool, in `checks` order. Shared with post-tool.js.
function runChecks(checks, input) {
  const tool = input && typeof input.tool_name === 'string' ? input.tool_name : '';
  const results = [];
  for (const [name, covers, load] of checks) {
    if (!covers(tool)) continue;
    try {
      const r = load().check(input);
      if (r) results.push(r);
    } catch (err) {
      logError(name, err);
    }
  }
  return results;
}

function main() {
  runHook('pre-tool', () => {
    const [first, ...rest] = runChecks(CHECKS, readInput()).filter(r => r.kind === 'deny');
    if (first) deny([first.reason, ...rest.map(d => `[bajzi:${d.rule}] ${d.reason}`)].join('\n'), first.rule);
  });
}

if (require.main === module) main();

module.exports = { runChecks };
