'use strict';
// ask-owner.js (SessionStart): ORCH_BUS_PANE non-empty -> the owner-questions rule as context; else nothing.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { NODE_DIR, runScript } = require('./helpers');
const { RULE } = require(path.join(NODE_DIR, 'ask-owner.js'));
const SCRIPT = path.join(NODE_DIR, 'ask-owner.js');
const run = (pane) => runScript(SCRIPT, '{}', { ORCH_BUS_PANE: pane }); // undefined deletes it from the child env
test('pane set -> RULE as SessionStart context with the key phrases', () => {
  const r = run('p-1');
  assert.equal(r.code, 0);
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, 'SessionStart');
  assert.equal(o.additionalContext, RULE);
  for (const s of ['mcp__orch-bus__ask_owner', 'select:mcp__orch-bus__ask_owner', 'Question for you in the panel: <title>',
    'set default_taken, carry on with it and do not wait', 'blocking=true', 'claude -p', 'never set blocking=true',
    'secret', 'Artifact checklist', 'ask the way your other instructions say', 'mcp__orch-bus__owner_answered', 'so the panel card closes']) assert.ok(RULE.includes(s), s);
});
test('pane unset or empty -> nothing', () => {
  for (const p of [undefined, '']) { const r = run(p); assert.deepEqual([r.code, r.stdout], [0, ''], String(p)); }
});
test('RULE is at most 2000 bytes', () => assert.ok(Buffer.byteLength(RULE) <= 2000, String(Buffer.byteLength(RULE))));
test('hooks.json registers it once on SessionStart with the full matcher', () => {
  const h = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '..', 'hooks.json'), 'utf8'));
  const e = h.hooks.SessionStart.filter((x) => x.hooks.some((c) => c.command.endsWith('hooks/node/ask-owner.js"')));
  assert.equal(e.length, 1);
  assert.equal(e[0].matcher, 'startup|clear|compact|resume');
});
