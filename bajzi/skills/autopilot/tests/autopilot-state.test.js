'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const S = path.join(__dirname, '..', 'autopilot-state.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-aps-'));
function run(arg, extra) {
  const env = { PATH: process.env.PATH, BAJZI_STATUS_DIR: dir, ...extra };
  return spawnSync(process.execPath, [S, arg].filter(Boolean), { env, encoding: 'utf8' });
}

test('on/status/off round trip with session id', () => {
  const e = { CLAUDE_CODE_SESSION_ID: 'sess1' };
  const f = path.join(dir, 'autopilot-sess1.json');
  assert.match(run('on', e).stdout, /^autopilot: on \(.*autopilot-sess1\.json\)/);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(j.v, 1); assert.strictEqual(j.key, 'sess1'); assert.strictEqual(j.session_id, 'sess1');
  assert.match(run('status', e).stdout, /^autopilot: on /);
  assert.strictEqual(run('off', e).stdout.trim(), 'autopilot: off');
  assert.ok(!fs.existsSync(f));
  assert.strictEqual(run('off', e).status, 0);
  assert.match(run('status', e).stdout, /^autopilot: off /);
});

test('pane key wins over session id', () => {
  run('on', { ORCH_BUS_PANE: 'pane7', CLAUDE_CODE_SESSION_ID: 'sess2' });
  assert.ok(fs.existsSync(path.join(dir, 'autopilot-pane7.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'autopilot-sess2.json')));
});

test('no key -> message, exit 0; bad arg -> exit 2', () => {
  const r = run('on', {});
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /no session key/);
  assert.strictEqual(run('bogus', {}).status, 2);
});
