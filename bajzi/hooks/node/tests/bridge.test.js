'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const b = require('../lib/bridge');

test('write then read round-trips used_pct', () => {
  const dir = tmpDir('bajzi-br-');
  const now = 1_800_000_000_000;
  assert.strictEqual(b.writeBridge('sess-1_A', 47, now, dir), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bajzi-ctx-sess-1_A.json'), 'utf8')), { used_pct: 47, ts: now });
  assert.strictEqual(b.readBridge('sess-1_A', now + 1000, 60, dir), 47);
});

test('a second write replaces the first (rename over an existing file)', () => {
  const dir = tmpDir('bajzi-br-');
  b.writeBridge('s', 10, 1000, dir);
  b.writeBridge('s', 20, 2000, dir);
  assert.strictEqual(b.readBridge('s', 2000, 60, dir), 20);
  assert.deepStrictEqual(fs.readdirSync(dir), ['bajzi-ctx-s.json']);   // no .tmp left behind
});

test('stale: exactly 60 s is fresh, 60.001 s is unknown (null)', () => {
  const dir = tmpDir('bajzi-br-');
  b.writeBridge('s', 55, 0, dir);
  assert.strictEqual(b.readBridge('s', 60000, 60, dir), 55);
  assert.strictEqual(b.readBridge('s', 60001, 60, dir), null);
});

test('a bridge dated more than 5 s in the future is unknown', () => {
  const dir = tmpDir('bajzi-br-');
  b.writeBridge('s', 55, 10000, dir);
  assert.strictEqual(b.readBridge('s', 4000, 60, dir), null);
});

test('missing, corrupt or wrongly typed bridge files read as null', () => {
  const dir = tmpDir('bajzi-br-');
  assert.strictEqual(b.readBridge('nope', 0, 60, dir), null);
  fs.writeFileSync(path.join(dir, 'bajzi-ctx-bad.json'), '{not json');
  assert.strictEqual(b.readBridge('bad', 0, 60, dir), null);
  fs.writeFileSync(path.join(dir, 'bajzi-ctx-str.json'), '{"used_pct":"55","ts":0}');
  assert.strictEqual(b.readBridge('str', 0, 60, dir), null);
});

test('writeBridge refuses a non-finite percentage', () => {
  const dir = tmpDir('bajzi-br-');
  assert.strictEqual(b.writeBridge('s', NaN, 0, dir), false);
  assert.strictEqual(b.writeBridge('s', '50', 0, dir), false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('RF1: unsafe session ids never write or read outside the dir', () => {
  const root = tmpDir('bajzi-br-');
  const dir = path.join(root, 'sub');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'bajzi-ctx-x.json'), JSON.stringify({ used_pct: 99, ts: 0 }));
  for (const id of ['../x', 'a/b', 'a\\b', 'C:x', '', '.', '..', 'x'.repeat(200), null, undefined, 5, 'a b', 'ä']) {
    assert.strictEqual(b.safeId(id), false, String(id));
    assert.strictEqual(b.bridgePath(id, dir), null, String(id));
    assert.strictEqual(b.warnPath(id, dir), null, String(id));
    assert.strictEqual(b.writeBridge(id, 50, 0, dir), false, String(id));
    assert.strictEqual(b.readBridge(id, 0, 60, dir), null, String(id));
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['bajzi-ctx-x.json', 'sub']);
});

test('M4: a pre-planted temp path is never followed or overwritten', () => {
  const dir = tmpDir('bajzi-br-');
  const planted = path.join(dir, `bajzi-ctx-s.json.${process.pid}.tmp`);
  fs.writeFileSync(planted, 'planted');
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'victim');
  const link = path.join(dir, `bajzi-ctx-l.json.${process.pid}.tmp`);
  let linked = true;
  try { fs.symlinkSync(victim, link); } catch { linked = false; }   // needs privileges on Windows
  assert.strictEqual(b.writeBridge('s', 33, 1000, dir), true);
  assert.strictEqual(b.readBridge('s', 1000, 60, dir), 33);
  assert.strictEqual(fs.readFileSync(planted, 'utf8'), 'planted');
  if (linked) {
    assert.strictEqual(b.writeBridge('l', 44, 1000, dir), true);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'victim');
  }
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp') && !n.includes(String(process.pid))), []);
});
