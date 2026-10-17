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
