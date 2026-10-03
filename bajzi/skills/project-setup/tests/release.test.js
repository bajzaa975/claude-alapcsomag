'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BAJZI = path.join(__dirname, '..', '..', '..');
const ROOT = path.join(BAJZI, '..');
const read = p => fs.readFileSync(p, 'utf8');
const noAlap = t => t.replace(/claude-alapcsomag/g, '').toLowerCase().includes('alapcsomag');

test('plugin.json and marketplace.json carry the same bajzi version', () => {
  const v = JSON.parse(read(path.join(BAJZI, '.claude-plugin', 'plugin.json'))).version;
  const m = JSON.parse(read(path.join(ROOT, '.claude-plugin', 'marketplace.json')));
  assert.strictEqual(m.plugins.find(p => p.name === 'bajzi').version, v);
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
  assert.strictEqual(cmds.length, 10);   // pre-tool, post-tool, radar notice, writer-guard notice, session-signal x6
  for (const c of cmds) {
    const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(c)[1];
    assert.ok(fs.existsSync(path.join(BAJZI, rel)), rel);
  }
});

const rootReadme = () => read(path.join(ROOT, 'README.md'));

test('README night-run bullet names the runner the skill launch block starts', () => {
  const bullet = /\*\*Night-run\*\*[\s\S]*?(?=\n\n|\n###)/.exec(rootReadme())[0];
  assert.match(read(path.join(BAJZI, 'skills', 'night-run', 'SKILL.md')), /setsid nohup bash .*run\.sh/);
  assert.match(bullet, /run\.sh/);
  assert.doesNotMatch(bullet, /PowerShell|Windows laptop/);
});

test('README Safety section names the fail-closed exceptions and the writer guard', () => {
  const safety = /### Safety[\s\S]*?(?=\n### )/.exec(rootReadme())[0];
  assert.match(safety, /\*\*Writer guard\*\*/);
  assert.match(safety, /pre-commit gate/);
  assert.match(safety, /day-run-mode\.sh/);
  assert.match(safety, /fail(s)? closed/);
});

test('every skill directory appears in the README Skills table', () => {
  const r = rootReadme();
  for (const d of fs.readdirSync(path.join(BAJZI, 'skills'), { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(BAJZI, 'skills', d.name, 'SKILL.md'))) {
      assert.ok(r.includes('| `' + d.name + '` |'), d.name);
    }
  }
});

test('spec §11 plugin-release row names the current plugin version', () => {
  const v = JSON.parse(read(path.join(BAJZI, '.claude-plugin', 'plugin.json'))).version;
  const row = read(path.join(ROOT, 'docs', 'bajzi-package-spec.md')).split('\n').find(l => l.startsWith('| bajzi plugin release |'));
  assert.ok(row && row.includes(v), row);
});
