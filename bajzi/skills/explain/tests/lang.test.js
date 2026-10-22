'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawnSync } = require('node:child_process');
const LANG = path.join(__dirname, '..', 'lang.js');
const run = (home, ...a) => spawnSync(process.execPath, [LANG, ...a], { env: { ...process.env, BAJZI_HOME: home }, encoding: 'utf8' });
const cfg = h => path.join(h, '.claude', 'bajzi', 'config.json');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lang-'));

test('get: empty when file missing, unreadable or unset', () => {
  const h = tmp();
  assert.deepEqual([run(h, 'get').status, run(h, 'get').stdout], [0, '']);
  fs.mkdirSync(path.dirname(cfg(h)), { recursive: true });
  fs.writeFileSync(cfg(h), '{nope');
  assert.deepEqual([run(h, 'get').status, run(h, 'get').stdout], [0, '']);
  fs.writeFileSync(cfg(h), '{"reviewer_models":["x"]}');
  assert.equal(run(h, 'get').stdout, '');
});
test('set creates file, get reads it, other keys kept', () => {
  const h = tmp();
  assert.equal(run(h, 'set', 'hu').status, 0);
  assert.equal(run(h, 'get').stdout.trim(), 'hu');
  fs.writeFileSync(cfg(h), '{"reviewer_models":["a"],"language":"en"}');
  assert.equal(run(h, 'set', 'pt-BR').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(h), 'utf8')), { reviewer_models: ['a'], language: 'pt-BR' });
});
test('set rejects bad codes and non-object config, file untouched', () => {
  const h = tmp();
  for (const c of ['', 'h', 'hungarian', 'hu_HU', 'hu-', '../x']) {
    const r = run(h, 'set', c); assert.equal(r.status, 2, c); assert.ok(r.stderr);
  }
  assert.ok(!fs.existsSync(cfg(h)));
  fs.mkdirSync(path.dirname(cfg(h)), { recursive: true });
  for (const body of ['[1]', '"s"', '{bad']) {
    fs.writeFileSync(cfg(h), body);
    assert.equal(run(h, 'set', 'hu').status, 2);
    assert.equal(fs.readFileSync(cfg(h), 'utf8'), body);
  }
});
