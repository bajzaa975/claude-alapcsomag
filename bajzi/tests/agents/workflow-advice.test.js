'use strict';
// Opt-in live eval of the workflow advice line (shared/CLAUDE.md Token budget). Plain `claude -p` at L0
// (override with BAJZI_CONTRACT_CLAUDE), needs a logged-in CLI. Skipped unless BAJZI_CONTRACT=1.
//   BAJZI_CONTRACT=1 node --test bajzi/tests/agents/workflow-advice.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE = process.env.BAJZI_CONTRACT_CLAUDE || 'claude';
const RULES = path.join(__dirname, '..', '..', '..', 'shared', 'CLAUDE.md');
const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT;
const skip = process.env.BAJZI_CONTRACT === '1' ? false : 'set BAJZI_CONTRACT=1 (calls claude -p)';

function ask(prompt) {
  const r = spawnSync(CLAUDE, ['-p', '--tools', '', '--model', 'sonnet', '--append-system-prompt-file', RULES],
    { input: prompt, encoding: 'utf8', timeout: 180e3, env: ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test('sequential same-file plan: not worth it', { skip, timeout: 200e3 }, () => {
  const out = ask('Execute this plan: task 1 adds a header to ui.html, task 2 adds a footer to ui.html, task 3 adds a sidebar to ui.html. All three tasks edit the one file ui.html, in order. Give only your advice line before acting.');
  assert.match(out, /^\W*Workflow: not worth it/m);
});

test('independent parallel audit: recommended', { skip, timeout: 200e3 }, () => {
  const out = ask('Plan: audit the auth module, the session-locking module and the payment module for defects, in parallel, they are independent. Give only your advice line before acting.');
  assert.match(out, /Workflow: recommended/);
});
