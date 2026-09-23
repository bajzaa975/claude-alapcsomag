'use strict';
// Runs the EXACT bash snippet documented in skills/handoff/SKILL.md (the fenced block that
// contains `check-ignore`), so the doc and the behaviour cannot drift. Needs Git Bash on Windows.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const block = (() => {
  const m = [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)].map(x => x[1]).find(b => b.includes('check-ignore'));
  return m;
})();
// ~ is a git work tree on the owner's laptop: stop discovery at the tmpdir (see hooks/node/tests/helpers.js).
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = cwd => spawnSync('bash', ['-c', block], { cwd, encoding: 'utf8' });
const gitInit = d => execFileSync('git', ['init', '-q', d]);

test('SKILL.md documents the dir + gitignore snippet', () => {
  assert.ok(block, 'no ```bash block containing check-ignore in SKILL.md');
  assert.match(block, /mkdir -p runtime\/handoff/);
  assert.match(block, /runtime\/handoff\//);
});

test('fresh repo: creates the dir and ONE ignore line, idempotent', () => {
  const d = tmp('bajzi-ho-');
  gitInit(d);
  assert.strictEqual(sh(d).status, 0);
  assert.strictEqual(sh(d).status, 0);
  assert.ok(fs.statSync(path.join(d, 'runtime', 'handoff')).isDirectory());
  const lines = fs.readFileSync(path.join(d, '.gitignore'), 'utf8').split(/\r?\n/).filter(l => l === 'runtime/handoff/');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(spawnSync('git', ['-C', d, 'check-ignore', '-q', 'runtime/handoff/x.md']).status, 0);
});

test('a repo that already ignores runtime/ is left alone', () => {
  const d = tmp('bajzi-ho-');
  gitInit(d);
  fs.writeFileSync(path.join(d, '.gitignore'), 'runtime/\n');
  sh(d);
  assert.strictEqual(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'runtime/\n');
});

test('outside a git repo: dir created, no .gitignore written', () => {
  const d = tmp('bajzi-ho-');
  sh(d);
  assert.ok(fs.existsSync(path.join(d, 'runtime', 'handoff')));
  assert.ok(!fs.existsSync(path.join(d, '.gitignore')));
});
