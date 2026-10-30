'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { resolveLevel: resolveFull } = require('../lib/saver-level');
const resolveLevel = a => { const { level, word } = resolveFull(a); return { level, word }; };   // the older tests pin {level, word}; src has its own test below

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
    let cwd;
    if (c.repo_file != null || c.no_cwd) {
      cwd = tmpDir('bajzi-lvc-');
      if (c.repo_file != null) fs.mkdirSync(path.join(cwd, 'runtime')), fs.writeFileSync(path.join(cwd, 'runtime', 'worker-mode'), Buffer.from(c.repo_file, 'utf8'));
      if (c.no_cwd) cwd = '';
    }
    const { level, word } = resolveLevel({ env, home, cwd });
    assert.deepStrictEqual({ level, word }, { level: c.expect_level, word: c.expect_word });
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
  for (const id of ['../x', '..', '', 'a b', 'a/b', 'x'.repeat(129), 'ñ', 42, null]) {
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

// --- repo default: <cwd>/runtime/worker-mode sits between BAJZI_SESSION_LEVEL and the machine file; src names the tier ---
function repo(body) {
  const cwd = tmpDir('bajzi-lvr-');
  fs.mkdirSync(path.join(cwd, 'runtime'));
  if (body !== null) fs.writeFileSync(path.join(cwd, 'runtime', 'worker-mode'), body);
  return cwd;
}
test('src names the tier that decided: env / session / inherited / repo / machine / none', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: 'tight\n' } });
  const cwd = repo('light\n');
  assert.strictEqual(resolveFull({ env: { CC_WORKER_MODE: 'claude' }, home, sessionId: 'A', cwd }).src, 'env');
  assert.strictEqual(resolveFull({ env: {}, home, sessionId: 'A', cwd }).src, 'session');
  assert.strictEqual(resolveFull({ env: { BAJZI_SESSION_LEVEL: 'glm' }, home, cwd }).src, 'inherited');
  assert.deepStrictEqual(resolveFull({ env: {}, home, cwd }), { level: 1, word: 'light', src: 'repo' });
  assert.strictEqual(resolveFull({ env: {}, home }).src, 'machine');
  assert.strictEqual(resolveFull({ env: {}, home, cwd: repo(null) }).src, 'machine');
  assert.deepStrictEqual(resolveFull({ env: {}, home: tmpDir('bajzi-lvl-') }), { level: 0, word: 'claude', src: 'none' });
});
test('the session file and BAJZI_SESSION_LEVEL beat the repo file; the repo file beats the machine file', () => {
  const { home } = fixture({ machine: 'glm\n', sessions: { A: 'light\n' } });
  const cwd = repo('tight\n');
  assert.strictEqual(resolveFull({ env: {}, home, sessionId: 'A', cwd }).word, 'light');
  assert.strictEqual(resolveFull({ env: { BAJZI_SESSION_LEVEL: 'light' }, home, cwd }).word, 'light');
  assert.strictEqual(resolveFull({ env: {}, home, sessionId: 'B', cwd }).word, 'tight');
});
test('a repo-file DIRECTORY is not a file; a relative or empty cwd with no file falls through', () => {
  const { home } = fixture({ machine: 'glm\n' });
  const cwd = tmpDir('bajzi-lvr-');
  fs.mkdirSync(path.join(cwd, 'runtime', 'worker-mode'), { recursive: true });
  assert.strictEqual(resolveFull({ env: {}, home, cwd }).word, 'glm');
  assert.strictEqual(resolveFull({ env: {}, home, cwd: 42 }).word, 'glm');
});
