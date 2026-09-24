'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BAJZI = path.join(__dirname, '..', '..', '..');
const ROOT = path.join(BAJZI, '..');
const read = p => fs.readFileSync(p, 'utf8');
const noAlap = t => t.replace(/claude-alapcsomag/g, '').toLowerCase().includes('alapcsomag');

test('version 1.9.0 in plugin.json and marketplace.json', () => {
  assert.strictEqual(JSON.parse(read(path.join(BAJZI, '.claude-plugin', 'plugin.json'))).version, '1.9.0');
  const m = JSON.parse(read(path.join(ROOT, '.claude-plugin', 'marketplace.json')));
  assert.strictEqual(m.plugins.find(p => p.name === 'bajzi').version, '1.9.0');
});

test('alapcsomag is retired: skill dir gone, no references left (the repo name aside)', () => {
  assert.ok(!fs.existsSync(path.join(BAJZI, 'skills', 'alapcsomag')));
  for (const f of [path.join(ROOT, 'README.md'), path.join(BAJZI, 'README.md'), path.join(BAJZI, 'skills', 'setup', 'SKILL.md'),
    path.join(BAJZI, 'skills', 'setup', 'manifest.json'), path.join(BAJZI, '.claude-plugin', 'plugin.json'),
    path.join(ROOT, '.claude-plugin', 'marketplace.json')]) {
    assert.ok(!noAlap(read(f)), f);
  }
});

test('README states the secret guard limit and the new commands', () => {
  const r = read(path.join(BAJZI, 'README.md'));
  assert.match(r, /pattern guard, not a shell parser/);
  assert.match(r, /\/bajzi:project-setup/);
  assert.match(r, /\/bajzi:setup --check/);
});

test('every node hook command in hooks.json points at an existing file', () => {
  const h = JSON.parse(read(path.join(BAJZI, 'hooks', 'hooks.json'))).hooks;
  const cmds = Object.values(h).flat().flatMap(e => e.hooks.map(k => k.command)).filter(c => c.startsWith('node '));
  assert.strictEqual(cmds.length, 4);
  for (const c of cmds) {
    const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(c)[1];
    assert.ok(fs.existsSync(path.join(BAJZI, rel)), rel);
  }
});
