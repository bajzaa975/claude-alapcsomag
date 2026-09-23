'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { load, configPath } = require('../lib/reviewer-models');

const LIB = path.join(__dirname, '..', 'lib', 'reviewer-models.js');

function home(content) {
  const h = tmpDir('bajzi-rm-');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(configPath(h)), { recursive: true });
    fs.writeFileSync(configPath(h), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return h;
}

test('a valid list loads in order; entry [0] first', () => {
  const r = load(home({ reviewer_models: ['claude-opus-5-5', 'claude-fable-5-1'] }));
  assert.deepStrictEqual(r, { ok: true, ids: ['claude-opus-5-5', 'claude-fable-5-1'] });
});

test('a UTF-8 BOM is tolerated', () => {
  assert.strictEqual(load(home('﻿{"reviewer_models":["claude-opus-5-5"]}')).ok, true);
});

test('a GLM id anywhere voids the WHOLE list (not filtered)', () => {
  const r = load(home({ reviewer_models: ['claude-opus-5-5', 'glm-5.3'] }));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /glm-5\.3/);
});

for (const [name, content, re] of [
  ['missing file', undefined, /missing/],
  ['malformed JSON', '{"reviewer_models": ["claude-opus-5-5"', /not valid JSON/],
  ['missing key', { other: 1 }, /missing or empty/],
  ['empty list', { reviewer_models: [] }, /missing or empty/],
  ['not a list', { reviewer_models: 'claude-opus-5-5' }, /missing or empty/],
  ['top level is an array', ['claude-opus-5-5'], /missing or empty/],
  ['non-string entry', { reviewer_models: ['claude-opus-5-5', 5] }, /not a claude- model id/],
  ['null entry', { reviewer_models: [null] }, /not a claude- model id/],
  ['bare prefix', { reviewer_models: ['claude-'] }, /not a claude- model id/],
  ['trailing newline', { reviewer_models: ['claude-x\n'] }, /not a claude- model id/],
  ['argument-injection shape', { reviewer_models: ['claude-x --dangerously-skip-permissions'] }, /not a claude- model id/],
]) {
  test(`invalid: ${name}`, () => {
    const r = load(home(content));
    assert.strictEqual(r.ok, false);
    assert.match(r.why, re);
  });
}

test('CLI: prints the list comma-joined, exit 0; invalid prints why, exit 1; BAJZI_HOME redirects', () => {
  const ok = spawnSync(process.execPath, [LIB], { env: { BAJZI_HOME: home({ reviewer_models: ['claude-a-1', 'claude-b-2'] }) }, encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.stdout, 'claude-a-1, claude-b-2\n');
  const bad = spawnSync(process.execPath, [LIB], { env: { BAJZI_HOME: home({ reviewer_models: ['glm-5.3'] }) }, encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /glm-5\.3/);
  const first = spawnSync(process.execPath, [LIB, '--first'], { env: { BAJZI_HOME: home({ reviewer_models: ['claude-a-1', 'claude-b-2'] }) }, encoding: 'utf8' });
  assert.strictEqual(first.stdout, 'claude-a-1\n');
});
