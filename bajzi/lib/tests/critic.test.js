'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require('../critic');

const CLI = path.join(__dirname, '..', 'findings-cli.js');
function repo(profile, crlf) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-critic-'));
  if (profile !== undefined) {
    fs.mkdirSync(path.join(d, '.claude'));
    let t = typeof profile === 'string' ? profile : JSON.stringify(profile, null, 2);
    if (crlf) t = '﻿' + t.replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(d, '.claude', 'project-profile.json'), t);
  }
  return d;
}
const sc = (n, slice, conf = 'high') => `## S${n} · ${slice} · ${conf}\ntrigger: t${n}\nbreaks: b${n}\ntest: x${n}\n\n`;
const HEAD = '# Critic · p\nmodel: fable\n\n';
function plan(d, stem, text, slices = 2) {
  fs.mkdirSync(path.join(d, 'runtime', 'critic'), { recursive: true });
  fs.mkdirSync(path.join(d, 'runtime', 'slices'), { recursive: true });
  for (let i = 1; i <= slices; i++) fs.writeFileSync(path.join(d, 'runtime', 'slices', `${stem}-t${i}.md`), 'tier: 2\n');
  fs.writeFileSync(path.join(d, 'runtime', 'critic', `${stem}.md`), text);
}

test('projectSize: M from a BOM+CRLF profile; missing/bad -> null', () => {
  assert.strictEqual(C.projectSize(repo({ size: 'M' }, true)), 'M');
  assert.strictEqual(C.projectSize(repo()), null);
  assert.strictEqual(C.projectSize(repo('{oops')), null);
  assert.strictEqual(C.projectSize(repo({ size: 'XL' })), null);
});

test('criticModel: opus, absent = fable, invalid throws', () => {
  assert.strictEqual(C.criticModel(repo({ plan_critic_model: 'opus' })), 'opus');
  assert.strictEqual(C.criticModel(repo({ size: 'M' })), 'fable');
  assert.strictEqual(C.criticModel(repo()), 'fable');
  assert.throws(() => C.criticModel(repo({ plan_critic_model: 'claude-opus-4-1' })), /plan_critic_model/);
});

test('parseCritic: header, scenarios, triage', () => {
  const p = C.parseCritic(HEAD + sc(1, 'p-t1') + sc(2, 'p-t2', 'low') + '## Triage\nauto: true\nS1: accept\nS2: reject\n');
  assert.strictEqual(p.header.model, 'fable');
  assert.deepStrictEqual(p.scenarios.map((s) => [s.id, s.slice, s.confidence, s.trigger]), [['S1', 'p-t1', 'high', 't1'], ['S2', 'p-t2', 'low', 't2']]);
  assert.deepStrictEqual(p.triage, { auto: true, skipped: null, verdicts: { S1: 'accept', S2: 'reject' } });
  assert.strictEqual(C.parseCritic(HEAD + '## Triage\nskipped: hotfix\n').triage.skipped, 'hotfix');
});

test('criticCheck: limits, unknown slice, bad confidence', () => {
  const ids = ['p-t1', 'p-t2'];
  assert.deepStrictEqual(C.criticCheck(HEAD + sc(1, 'p-t1') + sc(2, 'p-t2'), ids), []);
  assert.match(C.criticCheck(HEAD + [1, 2, 3, 4].map((n) => sc(n, 'p-t1')).join(''), ids).join('\n'), /more than 3/);
  const eleven = Array.from({ length: 11 }, (_, i) => sc(i + 1, i % 2 ? 'p-t1' : 'p-t2')).join('');
  assert.match(C.criticCheck(HEAD + eleven, ids).join('\n'), /more than 10/);
  assert.match(C.criticCheck(HEAD + sc(1, 'p-t9'), ids).join('\n'), /unknown slice/);
  assert.match(C.criticCheck(HEAD + sc(1, 'p-t1', 'sure'), ids).join('\n'), /confidence/);
});

test('criticReady: missing, partial, empty skipped -> false; full, skipped, auto -> true', () => {
  const d = repo({ size: 'M' });
  assert.strictEqual(C.criticReady(d, 'p').ok, false);
  const body = HEAD + sc(1, 'p-t1') + sc(2, 'p-t2');
  plan(d, 'p', body);
  assert.strictEqual(C.criticReady(d, 'p').ok, false);
  plan(d, 'p', body + '## Triage\nS1: accept\n');
  assert.strictEqual(C.criticReady(d, 'p').ok, false);
  plan(d, 'p', body + '## Triage\nskipped:\n');
  assert.strictEqual(C.criticReady(d, 'p').ok, false);
  plan(d, 'p', body + '## Triage\nS1: accept\nS2: reject\n');
  assert.strictEqual(C.criticReady(d, 'p').ok, true);
  plan(d, 'p', body + '## Triage\nskipped: hotfix\n');
  assert.strictEqual(C.criticReady(d, 'p').ok, true);
  plan(d, 'p', body + '## Triage\nauto: true\nS1: accept\nS2: reject\n');
  assert.strictEqual(C.criticReady(d, 'p').ok, true);
});

test('FC critic-model / critic-check / critic-ready', () => {
  const d = repo({ size: 'M', plan_critic_model: 'opus' });
  const run = (...a) => spawnSync('node', [CLI, ...a], { cwd: d, encoding: 'utf8' });
  assert.strictEqual(run('critic-model').stdout.trim(), 'opus');
  plan(d, 'p', HEAD + sc(1, 'p-t1'));
  assert.strictEqual(run('critic-check', 'p').status, 0);
  assert.strictEqual(run('critic-ready', 'p').status, 5);
  plan(d, 'p', HEAD + sc(1, 'p-t1') + '## Triage\nS1: accept\n');
  assert.strictEqual(run('critic-ready', 'p').status, 0);
  plan(d, 'p', HEAD + sc(1, 'p-t7'));
  assert.strictEqual(run('critic-check', 'p').status, 2);
  fs.writeFileSync(path.join(d, '.claude', 'project-profile.json'), '{"plan_critic_model":"gpt"}');
  assert.strictEqual(run('critic-model').status, 2);
});

test('criticCheck: a scenario heading in any other shape is an error naming its id', () => {
  const errs = C.criticCheck(HEAD + '## S2 · p-t1 · high (stateful)\ntrigger: a\nbreaks: b\ntest: c\n', ['p-t1']);
  assert.match(errs.join('\n'), /S2: .*heading/);
});

test('started: header is exposed as an ISO string or null; an unparseable value is a criticCheck error', () => {
  const ok = C.parseCritic(HEAD + 'started: 2026-11-10T08:00:00Z\n' + sc(1, 'p-t1'));
  assert.strictEqual(ok.header.started, '2026-11-10T08:00:00Z');
  assert.strictEqual(C.parseCritic(HEAD + sc(1, 'p-t1')).header.started, null);
  assert.deepStrictEqual(C.criticCheck(HEAD + 'started: 2026-11-10T08:00:00Z\n' + sc(1, 'p-t1'), ['p-t1']), []);
  assert.match(C.criticCheck(HEAD + 'started: yesterday\n' + sc(1, 'p-t1'), ['p-t1']).join('\n'), /started:/);
});
