'use strict';
// Opt-in live eval of the workflow advice line (shared/CLAUDE.md Token budget). Plain `claude -p` at L0
// (override with BAJZI_CONTRACT_CLAUDE), needs a logged-in CLI. Skipped unless BAJZI_CONTRACT=1.
//   BAJZI_CONTRACT=1 node --test bajzi/tests/agents/workflow-advice.test.js
// The child is isolated (no MCP, settings, hooks, tools) and runs in a temp fixture dir that holds what
// the prompt names, so it judges the plan instead of searching this repo.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE = process.env.BAJZI_CONTRACT_CLAUDE || 'claude';
const RULES = path.join(__dirname, '..', '..', '..', 'shared', 'CLAUDE.md');
const ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDECODE$|CC_ROUTER_ENTRY$|CC_ROUTER_WORKER$|NODE_TEST_CONTEXT$)/.test(k)));
const skip = process.env.BAJZI_CONTRACT === '1' ? false : 'set BAJZI_CONTRACT=1 (calls claude -p)';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-advice-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

function ask(prompt, files) {
  const cwd = fixture(files);
  try {
    const r = spawnSync(CLAUDE, ['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-session-persistence',
      '--append-system-prompt-file', RULES],
    { cwd, input: prompt, encoding: 'utf8', timeout: 180e3, env: ENV });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('sequential same-file plan: not worth it', { skip, timeout: 200e3 }, () => {
  const out = ask('Execute this plan: task 1 adds a header to ui.html, task 2 adds a footer to ui.html, task 3 adds a sidebar to ui.html. All three tasks edit the one file ui.html, in order. Reply with your first message before any tool use.',
    { 'ui.html': '<html><body></body></html>\n' });
  assert.match(out, /^\W*Workflow: not worth it\b/m, out);
});

test('independent parallel audit: recommended', { skip, timeout: 200e3 }, () => {
  const out = ask('Audit these three independent modules in parallel: auth/, session-lock/ and payment/. Reply with your first message before any tool use.',
    { 'auth/index.js': 'exports.login = () => {};\n', 'session-lock/index.js': 'exports.lock = () => {};\n', 'payment/index.js': 'exports.pay = () => {};\n' });
  assert.match(out, /^\W*Workflow: recommended\b(?!\s*\|)/m, out);
});
