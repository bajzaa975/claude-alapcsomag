'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { load, configPath, offListServed } = require('../lib/reviewer-models');

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

// Invariant 3: the live reviewer instructions name the reviewer allow-list, never a version-named
// model -- else a reviewer swap in config.json contradicts the text the session obeys.
test('live rules/prompt files name no version-named model (reviewer prose goes through the allow-list)', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const files = [
    'skills/night-run/templates/BRIEF.md.tmpl', 'skills/night-run/templates/config.env.tmpl',
    'skills/night-run/run.sh', 'skills/night-run/SKILL.md', 'skills/mode/SKILL.md',
    'skills/mode/DAY-RUN-RULES.md', 'skills/mode/SAVER-L1.md', 'skills/mode/SAVER-RULES.md',
    'skills/mode/SAVER-L3.md', 'skills/mode/GLM-WORKER.md', 'skills/mode/templates/dispatch-review.md',
  ];
  const re = /\b(?:opus|fable|sonnet|haiku)[ -]?\d|claude-(?:opus|fable|sonnet|haiku)/gi;
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((l, i) => {
      for (const m of l.matchAll(re)) hits.push(`${f}:${i + 1} ${m[0]}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

// F5: the review dispatch template's model line is the allow-list entry, not a model alias.
test('dispatch-review.md launches REVIEWER (allow-list [0]), never a bare alias', () => {
  const f = path.join(__dirname, '..', '..', '..', 'skills', 'mode', 'templates', 'dispatch-review.md');
  const first = fs.readFileSync(f, 'utf8').split(/\r?\n/)[0];
  assert.match(first, /^model: REVIEWER \(reviewer allow-list \[0\]\)/);
  assert.doesNotMatch(first, /\b(?:opus|fable|sonnet|haiku)\b/i);
});

test('offListServed: sub-agent transcript models, <synthetic> skipped, resolvedModel fallback, bad shapes', () => {
  const h = home({ reviewer_models: ['claude-opus-5-5'] });
  const tx = tmpDir('bajzi-tx-');
  fs.mkdirSync(path.join(tx, 's', 'subagents'), { recursive: true });
  const lines = [{ type: 'user', message: { model: 'glm-x' } }, { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'assistant', message: { model: '<synthetic>' } }, { type: 'assistant', message: { model: 'GLM-5.3' } }];
  fs.writeFileSync(path.join(tx, 's', 'subagents', 'agent-a1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n');
  const pay = (agentId, resolvedModel) => ({ transcript_path: path.join(tx, 's.jsonl'), tool_response: { agentId, resolvedModel } });
  assert.deepStrictEqual(offListServed(pay('a1', 'claude-opus-5-5'), h), ['glm-5.3']);
  assert.deepStrictEqual(offListServed(pay('none', 'claude-sonnet-5'), h), ['claude-sonnet-5']);
  assert.deepStrictEqual(offListServed(pay('../s/subagents/agent-a1', 'claude-opus-5-5'), h), []);
  assert.deepStrictEqual(offListServed({ tool_response: null }, h), []);
  assert.deepStrictEqual(offListServed(null, h), []);
  assert.deepStrictEqual(offListServed(pay('a1', ''), home({ reviewer_models: ['glm-5.3'] })), ['claude-opus-5-5', 'glm-5.3']);
});
