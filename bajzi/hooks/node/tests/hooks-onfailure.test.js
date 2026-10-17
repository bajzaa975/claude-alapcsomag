'use strict';
// hooks.json "onFailure": "block" (Claude Code 2.1.295+): a hook that cannot start, times out or
// exits with an unexpected code BLOCKS the tool call. Only the two security guards carry it, so
// every normal path of pre-tool.js must exit with an expected code (0 = allow/continue; a deny
// is a JSON envelope on exit 0, bajzi never uses exit 2).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { NODE_DIR, runScript } = require('./helpers');

const HOOKS = require(path.join(NODE_DIR, '..', 'hooks.json')).hooks;
const PRE = path.join(NODE_DIR, 'pre-tool.js');
const BLOCKING = ['PreToolUse:.*:node/pre-tool.js'];

const entries = [];
for (const [event, groups] of Object.entries(HOOKS)) {
  for (const g of groups) {
    for (const h of g.hooks) {
      entries.push({ key: `${event}:${g.matcher}:${h.command.replace(/.*\/hooks\//, '').replace(/"$/, '')}`, h });
    }
  }
}

test('the pre-tool.js security-guard entry fails closed: onFailure block, timeout 10', () => {
  for (const key of BLOCKING) {
    const e = entries.filter(x => x.key === key);
    assert.strictEqual(e.length, 1, `${key} wired once`);
    assert.strictEqual(e[0].h.onFailure, 'block', key);
    assert.strictEqual(e[0].h.timeout, 10, key);
  }
});

test('no other hooks.json entry has onFailure (a crash there never blocks work)', () => {
  const dg = entries.filter(x => x.key === 'PreToolUse:Agent|Task:dispatch-guard.sh');
  assert.strictEqual(dg.length, 1);
  assert.strictEqual(dg[0].h.timeout, 5);
  const others = entries.filter(x => !BLOCKING.includes(x.key));
  assert.ok(others.length > 0);
  for (const { key, h } of others) assert.ok(!('onFailure' in h), `${key} has onFailure`);
});

const pre = (tool_name, tool_input) => JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name, tool_input });

for (const [name, stdin] of [
  ['empty stdin', ''],
  ['malformed JSON', '{"tool_name": "Read", '],
  ['a plain allowed Read call', pre('Read', { file_path: 'README.md' })],
  ['an unknown tool', pre('SomeFutureTool', {})],
]) {
  test(`pre-tool.js: ${name} -> exit 0 (allow), no stdout`, () => {
    const r = runScript(PRE, stdin);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, '');
  });
}

test('pre-tool.js: a deny (secret read) -> exit 0 with the deny envelope, never exit 2', () => {
  const r = runScript(PRE, pre('Read', { file_path: '.env' }));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
