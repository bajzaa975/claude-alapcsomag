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

test('git timeout: existing cache left byte-identical', () => {
  const d = mk();
  execFileSync('git', ['init', '-q', d]);
  const cache = parts.gitCachePath(d);
  const body = JSON.stringify({ ts: 1, info: { branch: 'x', dirty: false } });
  fs.writeFileSync(cache, body);
  assert.strictEqual(parts.gitInfo(d, Date.now(), 1), null);
  assert.strictEqual(fs.readFileSync(cache, 'utf8'), body);
});

test('non-repo still caches null', () => {
  const d = mk();
  const cache = parts.gitCachePath(d);
  fs.rmSync(cache, { force: true });
  assert.strictEqual(parts.gitInfo(d), null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).info, null);
});
