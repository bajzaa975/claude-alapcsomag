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

test('bajzi README names the pre-push guard and both limits', () => {
  const r = read(path.join(BAJZI, 'README.md'));
  assert.match(r, /pre-push/);
  assert.match(r, /--no-verify/);
  assert.match(r, /core\.hooksPath/);
});

test('both READMEs give the git config command as the fresh-clone step, not a project-setup rerun', () => {
  for (const r of [read(path.join(ROOT, 'README.md')), read(path.join(BAJZI, 'README.md'))]) {
    const s = r.replace(/\s+/g, ' ');
    assert.match(s, /fresh clone runs no hook until you run `git config core\.hooksPath \.githooks`/);
    assert.doesNotMatch(s, /core\.hooksPath \.githooks` \(rerun \/bajzi:project-setup\)/);
  }
});

test('project-setup SKILL: the start assessment never runs under --check', () => {
  const s = read(path.join(BAJZI, 'skills', 'project-setup', 'SKILL.md'));
  const sec = /## Start assessment\r?\n([\s\S]*?)\n## /.exec(s)[1];
  assert.match(sec, /never under `--check`/);
});

test('every node hook command in hooks.json points at an existing file', () => {
  const h = JSON.parse(read(path.join(BAJZI, 'hooks', 'hooks.json'))).hooks;
  const cmds = Object.values(h).flat().flatMap(e => e.hooks.map(k => k.command)).filter(c => c.startsWith('node '));
  assert.strictEqual(cmds.length, 13);   // pre-tool, post-tool, radar notice, writer-guard notice, session-signal x6, tired, ask-owner, level
  for (const c of cmds) {
    const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(c)[1];
    assert.ok(fs.existsSync(path.join(BAJZI, rel)), rel);
  }
});

const rootReadme = () => read(path.join(ROOT, 'README.md'));

test('README night-run bullet names the runner the skill launch block starts', () => {
  const bullet = /\*\*Night-run\*\*[\s\S]*?(?=\n\n|\n###)/.exec(rootReadme())[0];
  assert.match(read(path.join(BAJZI, 'skills', 'night-run', 'templates', 'launch.sh.tmpl')), /setsid nohup bash .*RUN_SH/);
  assert.match(read(path.join(BAJZI, 'skills', 'night-run', 'SKILL.md')), /bash <NIGHT_DIR>\/launch\.sh/);
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

test('marketplace ships bajzi, bajzi-cowork and the two mods', () => {
  const m = JSON.parse(read(path.join(ROOT, '.claude-plugin', 'marketplace.json')));
  assert.deepStrictEqual(m.plugins.map(p => p.name), ['bajzi', 'bajzi-cowork', 'cache-timer', 'nightrun-pane']);
});

test('project-setup SKILL: start assessment leaves git init to Apply; Apply step 1 exempts the profile and fresh repos', () => {
  const s = read(path.join(BAJZI, 'skills', 'project-setup', 'SKILL.md'));
  assert.doesNotMatch(s, /-> `git init` first/);
  assert.match(s, /do NOT run `git init`/);
  assert.match(s, /':!\.claude\/project-profile\.json'/);
  assert.match(s, /no commits/);
});

test('both READMEs say upgrading to M/L means adding gate', () => {
  for (const r of [read(path.join(ROOT, 'README.md')), read(path.join(BAJZI, 'README.md'))]) {
    assert.match(r, /upgrade = change `?size`?, add `gate` for M\/L, rerun/);
  }
});
