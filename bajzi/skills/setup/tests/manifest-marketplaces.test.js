'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../manifest.json');

test('every marketplaces entry has a name and a source', () => {
  for (const e of m.marketplaces) assert.ok(e.name && e.source, JSON.stringify(e));
});

test('every installable plugin id resolves to exactly one marketplaces entry by name', () => {
  for (const p of m.plugins) {
    const at = p.id.split('@')[1];
    if (!at) continue;
    assert.strictEqual(m.marketplaces.filter(e => e.name === at).length, 1, p.id);
  }
});

test('PHASE D step 2 does not register every missing marketplace on 2.1.292+', () => {
  const t = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'SKILL.md'), 'utf8');
  const step2 = t.split('2. The manifest\'s `marketplaces` list')[1].split('3. The manifest\'s `plugins`')[0];
  assert.match(step2, /below Claude Code 2\.1\.292/);
});
