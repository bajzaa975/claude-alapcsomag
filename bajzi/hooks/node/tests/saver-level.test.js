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
