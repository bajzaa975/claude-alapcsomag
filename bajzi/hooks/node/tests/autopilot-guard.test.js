'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const A = require('../lib/autopilot');
const G = require('../autopilot-guard');

const dir = tmpDir('bajzi-ap-');
const env = { BAJZI_STATUS_DIR: dir };
const mark = (key) => { fs.writeFileSync(path.join(dir, `autopilot-${key}.json`), '{}'); };
function withEnv(e, fn) {
  const old = process.env;
  process.env = { ...old, BAJZI_NIGHT_RUN: '', ORCH_BUS_PANE: '', ...e };
  try { return fn(); } finally { process.env = old; }
}
const ask = (tool_name, tool_input, session_id = 's1') => ({ tool_name, tool_input, session_id });

test('lib: pane key wins, unsafe key is off, night run is on, other key does not match', () => {
  assert.ok(A.markerPath({ env: { ...env, ORCH_BUS_PANE: 'p1' }, sessionId: 's1' }).endsWith('autopilot-p1.json'));
  assert.ok(A.markerPath({ env, sessionId: 's1' }).endsWith('autopilot-s1.json'));
  assert.strictEqual(A.markerPath({ env, sessionId: '../x' }), null);
  assert.strictEqual(A.isOn({ env, sessionId: '../x' }), false);
  assert.strictEqual(A.isOn({ env: { ...env, BAJZI_NIGHT_RUN: '1' } }), true);
  mark('other');
  assert.strictEqual(A.isOn({ env, sessionId: 's1' }), false);
  mark('s1');
  assert.strictEqual(A.isOn({ env, sessionId: 's1' }), true);
  assert.strictEqual(A.isOn({ env: { ...env, ORCH_BUS_PANE: 'p9' }, sessionId: 's1' }), false);
  fs.unlinkSync(path.join(dir, 'autopilot-s1.json'));
});

test('guard: on denies AskUserQuestion and blocking ask_owner, allows the rest', () => {
  mark('g1');
  withEnv({ BAJZI_STATUS_DIR: dir }, () => {
    assert.strictEqual(G.check(ask('AskUserQuestion', {}, 'g1')).kind, 'deny');
    const r = G.check(ask('mcp__orch-bus__ask_owner', { blocking: true }, 'g1'));
    assert.strictEqual(r.kind, 'deny');
    assert.strictEqual(r.rule, 'autopilot-guard');
    assert.match(r.reason, /^Autopilot: no blocking owner questions\./);
    assert.strictEqual(G.check(ask('mcp__orch-bus__ask_owner', { blocking: false }, 'g1')), null);
    assert.strictEqual(G.check(ask('mcp__orch-bus__ask_owner', { default_taken: 'x' }, 'g1')), null);
    assert.strictEqual(G.check(ask('mcp__orch-bus__ask_owner', { blocking: false, default_taken: 'x' }, 'g1')), null);
    assert.strictEqual(G.check(ask('Bash', {}, 'g1')), null);
    // marker for another key does not deny
    assert.strictEqual(G.check(ask('AskUserQuestion', {}, 'zz')), null);
  });
});

test('guard: off allows everything; night-run env denies without a marker', () => {
  withEnv({ BAJZI_STATUS_DIR: dir }, () => {
    assert.strictEqual(G.check(ask('AskUserQuestion', {}, 'nomark')), null);
    assert.strictEqual(G.check(ask('x__ask_owner', { blocking: true }, 'nomark')), null);
  });
  withEnv({ BAJZI_STATUS_DIR: dir, BAJZI_NIGHT_RUN: '1' }, () => {
    assert.strictEqual(G.check(ask('AskUserQuestion', {}, 'nomark')).kind, 'deny');
  });
});
