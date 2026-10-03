'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { resolveLevel } = require('../lib/saver-level');

const CASES = require(path.join(__dirname, '..', '..', 'tests', 'saver-level-cases.json')).cases;

for (const c of CASES) {
  test(`parity case ${c.name}`, () => {
    const home = tmpDir('bajzi-lvl-');
    fs.mkdirSync(path.join(home, '.claude'));
    if (c.worker_mode_file !== null) {
      fs.writeFileSync(path.join(home, '.claude', 'worker-mode'), Buffer.from(c.worker_mode_file, 'utf8'));
    }
    const env = {};
    if (c.base_url !== null) env.ANTHROPIC_BASE_URL = c.base_url;
    if (c.worker_mode_env !== null) env.CC_WORKER_MODE = c.worker_mode_env;
    assert.deepStrictEqual(resolveLevel({ env, home }), { level: c.expect_level, word: c.expect_word });
  });
}

test('a worker-mode DIRECTORY is not a file (bash -f): level claude', () => {
  const home = tmpDir('bajzi-lvl-');
  fs.mkdirSync(path.join(home, '.claude', 'worker-mode'), { recursive: true });
  assert.deepStrictEqual(resolveLevel({ env: {}, home }), { level: 0, word: 'claude' });
});

test('the case table covers every level word and both provider outcomes', () => {
  const words = new Set(CASES.map(c => c.expect_word));
  for (const w of ['claude', 'light', 'glm', 'tight']) assert.ok(words.has(w), w);
  assert.ok(CASES.some(c => c.base_url !== null && c.expect_word === 'tight'));
  assert.ok(CASES.some(c => c.base_url !== null && c.expect_word !== 'tight'));
});

// --- per-session level: <status dir>/<session_id>.level beats worker-mode, CC_WORKER_MODE beats both ---
function fixture({ machine = null, sessions = {} } = {}) {
  const home = tmpDir('bajzi-lvl-');
  const dir = path.join(home, '.claude', 'bajzi', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  if (machine !== null) fs.writeFileSync(path.join(home, '.claude', 'worker-mode'), machine);
  for (const [id, body] of Object.entries(sessions)) fs.writeFileSync(path.join(dir, id + '.level'), body);
  return { home, dir };
}
test('THE regression: machine default glm, session A set tight -> A resolves tight, B resolves glm', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: 'tight\n' } });
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'A' }), { level: 3, word: 'tight' });
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'B' }), { level: 2, word: 'glm' });
  assert.deepStrictEqual(resolveLevel({ env: {}, home }), { level: 2, word: 'glm' });   // no session id
});
test('BAJZI_STATUS_DIR overrides where the session file is read', () => {
  const { home } = fixture({ machine: 'glm\n' });
  const alt = tmpDir('bajzi-sd-');
  fs.writeFileSync(path.join(alt, 'A.level'), 'light\n');
  assert.deepStrictEqual(resolveLevel({ env: { BAJZI_STATUS_DIR: alt }, home, sessionId: 'A' }), { level: 1, word: 'light' });
});
test('env CC_WORKER_MODE beats the session file', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: 'tight\n' } });
  assert.deepStrictEqual(resolveLevel({ env: { CC_WORKER_MODE: 'light' }, home, sessionId: 'A' }), { level: 1, word: 'light' });
});
test('a non-Anthropic provider forces tight over a session file', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: 'claude\n' } });
  assert.deepStrictEqual(resolveLevel({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }, home, sessionId: 'A' }), { level: 3, word: 'tight' });
});
test('an empty session file (or a blank first line) falls through to worker-mode', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: '', C: ' \r\ntight\n' } });
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'A' }), { level: 2, word: 'glm' });
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'C' }), { level: 2, word: 'glm' });
});
test('the session file is normalised like worker-mode (BOM, CRLF, case) and an unknown word still wins as L0', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: '\ufeff Light\r\n', U: 'turbo\n' } });
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'A' }), { level: 1, word: 'light' });
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'U' }), { level: 0, word: 'turbo' });
});
test('an unsafe session id never reads a file outside the status dir', () => {
  const { home, dir } = fixture({ machine: 'glm\n' });
  fs.writeFileSync(path.join(dir, '..', 'x.level'), 'tight\n');
  for (const id of ['../x', '..', '', 'a b', 'a/b', 'x'.repeat(129), 'é', 42, null]) {
    assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: id }), { level: 2, word: 'glm' }, String(id));
  }
  fs.writeFileSync(path.join(dir, 'x'.repeat(128) + '.level'), 'tight\n');
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'x'.repeat(128) }), { level: 3, word: 'tight' });
});
test('a session-file DIRECTORY is not a file: falls through', () => {
  const { home, dir } = fixture({ machine: 'light\n' });
  fs.mkdirSync(path.join(dir, 'A.level'));
  assert.deepStrictEqual(resolveLevel({ env: {}, home, sessionId: 'A' }), { level: 1, word: 'light' });
});
