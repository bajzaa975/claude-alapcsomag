'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const parts = require('../lib/status-parts');

function mk() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-gt-')); }

test('git timeout: null and no cache written', () => {
  const d = mk();
  execFileSync('git', ['init', '-q', d]);
  const cache = parts.gitCachePath(d);
  fs.rmSync(cache, { force: true });
  assert.strictEqual(parts.gitInfo(d, Date.now(), 1), null);
  assert.ok(!fs.existsSync(cache));
});

test('git timeout: an expired cache entry with a valid branch yields null and stays byte-identical', () => {
  const d = mk();
  execFileSync('git', ['init', '-q', d]);
  const cache = parts.gitCachePath(d);
  const body = JSON.stringify({ ts: 1, info: { branch: 'x', dirty: false } });
  fs.writeFileSync(cache, body);
  assert.strictEqual(parts.gitInfo(d, Date.now(), 1), null);
  assert.strictEqual(fs.readFileSync(cache, 'utf8'), body);
});

test('git timeout: an invalid expired cache entry yields null', () => {
  const d = mk();
  execFileSync('git', ['init', '-q', d]);
  const cache = parts.gitCachePath(d);
  fs.writeFileSync(cache, JSON.stringify({ ts: 1, info: { branch: '[31m', dirty: false } }));
  assert.strictEqual(parts.gitInfo(d, Date.now(), 1), null);
});

test('non-repo still caches null', () => {
  const d = mk();
  const cache = parts.gitCachePath(d);
  fs.rmSync(cache, { force: true });
  assert.strictEqual(parts.gitInfo(d), null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).info, null);
});

// --- goalStatus ---
let gseq = 0;
const gid = () => `goaltest-${process.pid}-${++gseq}`;
const gline = (a, extra = {}) => JSON.stringify(Object.assign({ type: 'attachment', timestamp: '2026-11-03T10:00:00.000Z', attachment: Object.assign({ type: 'goal_status', condition: 'c' }, a) }, extra)) + '\n';
const SET = gline({ met: false, sentinel: true });
const EV = gline({ met: false, reason: 'r' });
const MET = gline({ met: true, iterations: 2 });
const CLEAR = gline({ met: true, sentinel: true });
const FAIL = gline({ met: false, failed: true });
function gfile(content) { const f = path.join(mk(), 't.jsonl'); fs.writeFileSync(f, content); return f; }
const gs = (f, id, chunk) => parts.goalStatus({ transcriptPath: f, sessionId: id, nowMs: Date.now(), chunk });
const gcache = id => path.join(os.tmpdir(), `bajzi-goal-${id}.json`);

test('goal: state transitions', () => {
  const t = (c) => gs(gfile(c), gid());
  assert.strictEqual(t(SET + EV + EV + MET), null);
  assert.strictEqual(t(SET + FAIL), null);
  assert.strictEqual(t(SET + EV + CLEAR), null);
  assert.deepStrictEqual(t(SET + EV + CLEAR + SET), { evals: 0, setAt: Date.parse('2026-11-03T10:00:00.000Z') });
  assert.strictEqual(t(SET + EV + CLEAR + SET + EV).evals, 1);
  assert.strictEqual(t('{"type":"user"}\n' + SET + EV + EV).evals, 2);
});

test('goal: quoted record in a string and sidechain are ignored', () => {
  const quote = JSON.stringify({ type: 'user', message: '"attachment":{"type":"goal_status","met":false,"sentinel":true}' }) + '\n';
  assert.strictEqual(gs(gfile(quote), gid()), null);
  assert.strictEqual(gs(gfile(gline({ met: false, sentinel: true }, { isSidechain: true })), gid()), null);
});

test('goal: torn last line is not consumed until complete', () => {
  const id = gid();
  const f = gfile(SET + EV.slice(0, -1));
  assert.strictEqual(gs(f, id).evals, 0);
  fs.appendFileSync(f, '\n');
  assert.strictEqual(gs(f, id).evals, 1);
});

test('goal: shrink, path change and ino change reset', () => {
  const id = gid();
  const f = gfile(SET + EV + EV);
  assert.strictEqual(gs(f, id).evals, 2);
  fs.writeFileSync(f, SET);                                   // shrink
  assert.strictEqual(gs(f, id).evals, 0);
  assert.strictEqual(gs(gfile(SET + EV), id).evals, 1);       // other path
  const g = gfile(SET + EV + EV + EV);
  assert.strictEqual(gs(g, id).evals, 3);
  const g2 = g + '.new';
  fs.writeFileSync(g2, SET + EV + EV + EV + EV);              // same size class, new inode
  fs.renameSync(g2, g);
  assert.strictEqual(gs(g, id).evals, 4);
});

test('goal: tiny chunk reaches the same state, incl. a line longer than the chunk', () => {
  const big = JSON.stringify({ type: 'user', message: 'x'.repeat(500) }) + '\n';
  const c = SET + big + EV + big + EV + EV;
  const f = gfile(c);
  const id = gid();
  let r;
  for (let i = 0; i < 60; i++) r = gs(f, id, 256);
  assert.deepStrictEqual(r, gs(f, gid()));
  assert.strictEqual(r.evals, 3);
});

test('goal: bad cache is fresh state; non-SAFE_ID -> null, no cache', () => {
  const id = gid();
  const f = gfile(SET + EV);
  for (const bad of ['not json', '{"v":2}', '{"v":1,"path":1}', '[]']) {
    fs.writeFileSync(gcache(id), bad);
    assert.strictEqual(gs(f, id).evals, 1);
  }
  assert.strictEqual(gs(f, '../evil'), null);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'bajzi-goal-../evil.json')));
  assert.strictEqual(gs('', id), null);
  assert.strictEqual(gs(path.join(mk(), 'nope'), id), null);
});
