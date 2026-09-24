'use strict';
// Fixture-repo tests for the pre-commit gate. Every tool is a fake shim on a minimal PATH (fake
// bin dir + node + git), so no real ruff/eslint/pyright/tsc/gitleaks is needed or reached. The
// gate's verdict is read from its exit code only (0 clean, 1 blocked, 2 tool error).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.join(__dirname, '..', 'pre-commit.js');
const WIN = process.platform === 'win32';
// git's own dir; on Windows the cmd/ wrapper dir, which puts Git's usr/bin (the hook's
// /usr/bin/env) on the hook's PATH the way a normal Git for Windows install does.
const GIT_CORE = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
const GIT_CMD = path.resolve(GIT_CORE, '..', '..', '..', 'cmd');
const GIT_DIR = WIN && fs.existsSync(path.join(GIT_CMD, 'git.exe')) ? GIT_CMD : GIT_CORE;

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// files: {relpath: content}; stage: relpaths to `git add`.
function repo(files, stage = Object.keys(files)) {
  const r = tmp('bajzi-gate-');
  git(r, 'init', '-q');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(r, 'config', k, v);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
    fs.writeFileSync(path.join(r, rel), text);
  }
  if (stage.length) git(r, 'add', '--', ...stage);
  return r;
}

// tools: {name: {exit, stdout}}; each fake logs its argv + cwd to <name>.log in the bin dir.
function fakes(tools) {
  const bin = tmp('bajzi-gate-bin-');
  for (const [name, cfg] of Object.entries(tools)) {
    fs.writeFileSync(path.join(bin, name + '.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(bin, name + '.js'), [
      "const fs = require('fs'), p = require('path');",
      `const cfg = JSON.parse(fs.readFileSync(p.join(__dirname, ${JSON.stringify(name + '.json')}), 'utf8'));`,
      `fs.appendFileSync(p.join(__dirname, ${JSON.stringify(name + '.log')}), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');`,
      "process.stdout.write(cfg.stdout || '');",
      'process.exit(cfg.exit || 0);',
    ].join('\n'));
    if (WIN) fs.writeFileSync(path.join(bin, name + '.cmd'), `@node "%~dp0${name}.js" %*\r\n`);
    else {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec node "$(dirname "$0")/${name}.js" "$@"\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  return bin;
}
const calls = (bin, name) => {
  try { return fs.readFileSync(path.join(bin, name + '.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; }
};

function env(pathDirs) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH' && k !== 'NODE_TEST_CONTEXT') e[k] = v;
  e.PATH = pathDirs.join(path.delimiter);
  return e;
}
const minimalPath = bin => [bin, path.dirname(process.execPath), GIT_DIR];

function gate(r, bin, args = [], pathDirs = minimalPath(bin)) {
  const x = spawnSync(process.execPath, [GATE, ...args], { cwd: r, env: env(pathDirs), encoding: 'utf8' });
  return { code: x.status, out: (x.stdout || '') + (x.stderr || '') };
}

const pyright = n => ({ exit: n ? 1 : 0, stdout: JSON.stringify({ summary: { errorCount: n } }) });
const tsc = n => ({ exit: n ? 2 : 0, stdout: Array.from({ length: n }, (_, i) => `src/a.ts(${i + 1},1): error TS2322: bad\n`).join('') });
const CLEAN = { exit: 0, stdout: '' };
const PY = { 'pyproject.toml': '[project]\nname = "x"\n', '.gate-baseline.json': '{"pyright": 3}\n' };

test('staged ruff error blocks (exit 1); ruff sees only the staged .py files', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n', 'b.py': 'y=2\n' }), ['a.py']);
  const bin = fakes({ gitleaks: CLEAN, ruff: { exit: 1 }, pyright: pyright(3) });
  assert.strictEqual(gate(r, bin).code, 1);
  const c = calls(bin, 'ruff');
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].argv, ['check', '--', 'a.py']);
});

test('count-equal passes and leaves the baseline alone', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(3) });
  assert.strictEqual(gate(r, bin).code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 3 });
});

test('count-up blocks (exit 1) and leaves the baseline alone', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(4) });
  assert.strictEqual(gate(r, bin).code, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 3 });
});

test('count-down rewrites the baseline and stages it (exit 0)', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }), ['a.py']);
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(2) });
  assert.strictEqual(gate(r, bin).code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 2 });
  assert.match(git(r, 'diff', '--cached', '--name-only').stdout, /^\.gate-baseline\.json$/m);
  assert.strictEqual(git(r, 'status', '--porcelain', '--', '.gate-baseline.json').stdout.trim(), 'A  .gate-baseline.json');
});

test('count-down while another tool blocks: no rewrite, exit 1', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }), ['a.py']);
  const bin = fakes({ gitleaks: CLEAN, ruff: { exit: 1 }, pyright: pyright(1) });
  assert.strictEqual(gate(r, bin).code, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 3 });
});

test('missing needed tool blocks with the install hint (exit 2)', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const bin = fakes({ gitleaks: CLEAN, pyright: pyright(3) });   // no ruff anywhere on PATH
  const res = gate(r, bin);
  assert.strictEqual(res.code, 2);
  assert.match(res.out, /ruff.*pip install ruff/);
});

test('absent stack skipped: no pyproject.toml / package.json means no ruff/pyright/eslint/tsc needed', () => {
  const r = repo({ 'a.py': 'x=1\n', 'b.ts': 'let x = 1\n' });
  const bin = fakes({ gitleaks: CLEAN });   // only gitleaks exists
  assert.strictEqual(gate(r, bin).code, 0);
  assert.strictEqual(calls(bin, 'gitleaks').length, 1);
});

test('gitleaks hit blocks (exit 1); it scans the staged diff', () => {
  const r = repo({ 'a.txt': 'hello\n' });
  const bin = fakes({ gitleaks: { exit: 1 } });
  assert.strictEqual(gate(r, bin).code, 1);
  assert.deepStrictEqual(calls(bin, 'gitleaks')[0].argv.slice(0, 2), ['protect', '--staged']);
});

test('exit codes only: tool text never decides the verdict', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  let bin = fakes({ gitleaks: CLEAN, ruff: { exit: 1, stdout: 'All checks passed!\n' }, pyright: pyright(3) });
  assert.strictEqual(gate(r, bin).code, 1);
  bin = fakes({ gitleaks: { exit: 0, stdout: 'leaks found: 3\n' }, ruff: { exit: 0, stdout: 'Found 9 errors.\n' }, pyright: pyright(3) });
  assert.strictEqual(gate(r, bin).code, 0);
  bin = fakes({ gitleaks: CLEAN, ruff: { exit: 2 }, pyright: pyright(3) });
  assert.strictEqual(gate(r, bin).code, 2);   // a tool error blocks as 2
  bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: { exit: 1, stdout: 'not json' } });
  assert.strictEqual(gate(r, bin).code, 2);   // an unreadable count is a tool error, never a pass
});

test('node stack in a subdirectory: eslint on its staged files from that dir, tsc ratchet with tsconfig', () => {
  const r = repo({ 'web/package.json': '{}', 'web/tsconfig.json': '{}', 'web/src/x.ts': 'let x = 1\n', 'README.md': '# r\n', '.gate-baseline.json': '{"tsc": 2}\n' });
  let bin = fakes({ gitleaks: CLEAN, eslint: { exit: 1 }, tsc: tsc(2) });
  assert.strictEqual(gate(r, bin).code, 1);
  const c = calls(bin, 'eslint')[0];
  assert.deepStrictEqual(c.argv, ['--', 'src/x.ts']);
  assert.strictEqual(fs.realpathSync(c.cwd), fs.realpathSync(path.join(r, 'web')));
  bin = fakes({ gitleaks: CLEAN, eslint: CLEAN, tsc: tsc(3) });
  assert.strictEqual(gate(r, bin).code, 1);   // ratchet up
  bin = fakes({ gitleaks: CLEAN, eslint: CLEAN, tsc: tsc(2) });
  assert.strictEqual(gate(r, bin).code, 0);
});

test('a project-local tool (node_modules/.bin) is found without PATH', () => {
  const r = repo({ 'web/package.json': '{}', 'web/x.js': 'x\n' });
  const bin = fakes({ gitleaks: CLEAN });
  const local = fakes({ eslint: CLEAN });
  fs.mkdirSync(path.join(r, 'web', 'node_modules'), { recursive: true });
  fs.renameSync(local, path.join(r, 'web', 'node_modules', '.bin'));
  assert.strictEqual(gate(r, bin).code, 0);
  assert.strictEqual(calls(path.join(r, 'web', 'node_modules', '.bin'), 'eslint').length, 1);
});

test('--init writes the baseline from the project-wide counts; a missing baseline is a tool error', () => {
  const r = repo({ 'pyproject.toml': '', 'web/package.json': '{}', 'web/tsconfig.json': '{}' }, []);
  const bin = fakes({ gitleaks: CLEAN, pyright: pyright(5), tsc: tsc(2) });
  assert.strictEqual(gate(r, bin).code, 2);   // no .gate-baseline.json yet
  assert.strictEqual(gate(r, bin, ['--init']).code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 5, tsc: 2 });
  assert.strictEqual(gate(r, fakes({ gitleaks: CLEAN, tsc: tsc(2) }), ['--init']).code, 2);   // pyright missing
});

test('profile gate.tools narrows the tool set; gate.baseline moves the file', () => {
  const r = repo({ 'pyproject.toml': '', 'a.py': 'x\n', 'gate/base.json': '{}', '.claude/project-profile.json': JSON.stringify({ version: 1, gate: { tools: ['gitleaks', 'ruff'], baseline: 'gate/base.json' } }) });
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN });   // no pyright: not in the tool list
  assert.strictEqual(gate(r, bin).code, 0);
  fs.writeFileSync(path.join(r, '.claude', 'project-profile.json'), '{ broken');
  assert.strictEqual(gate(r, bin).code, 2);   // an unreadable profile fails closed
});

test('installed by project-setup: a real `git commit` runs the gate and is refused on a block', () => {
  const r = repo({ 'pyproject.toml': '', 'a.py': 'x\n', '.claude/project-profile.json': JSON.stringify({ version: 1, gate: { tools: ['gitleaks', 'ruff'] } }) }, []);
  git(r, 'config', 'core.hooksPath', '.githooks');
  const P = require('../../skills/project-setup/profile');
  const prof = JSON.parse(fs.readFileSync(path.join(r, '.claude', 'project-profile.json'), 'utf8'));
  P.apply(prof, r, { home: tmp('bajzi-gate-home-'), run: () => 0 });
  git(r, 'add', '--', 'pyproject.toml', 'a.py', '.claude/project-profile.json', '.githooks/pre-commit');
  const commit = bin => spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: r, env: env(minimalPath(bin)), encoding: 'utf8' });
  const blockBin = fakes({ gitleaks: CLEAN, ruff: { exit: 1 } });
  const blocked = commit(blockBin);
  assert.notStrictEqual(blocked.status, 0, blocked.stderr);
  assert.strictEqual(calls(blockBin, 'ruff').length, 1);   // refused by the gate, not by a spawn failure
  assert.notStrictEqual(git(r, 'rev-parse', '--verify', '-q', 'HEAD').status, 0);   // nothing committed
  const ok = commit(fakes({ gitleaks: CLEAN, ruff: CLEAN }));
  assert.strictEqual(ok.status, 0, ok.stderr);
});

test('tsc: a location-less error (TS5058 config error) is exit 2 and the baseline is untouched', () => {
  const r = repo({ 'package.json': '{}', 'tsconfig.json': '{}', 'x.md': 'a\n', '.gate-baseline.json': '{"tsc": 40}\n' }, ['x.md']);
  let bin = fakes({ gitleaks: CLEAN, tsc: { exit: 1, stdout: "error TS5058: The specified path does not exist: 'tsconfig.json'.\n" } });
  let res = gate(r, bin);
  assert.strictEqual(res.code, 2, res.out);
  assert.match(res.out, /tsc: 1 error TS line\(s\) without a file location/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { tsc: 40 });
  bin = fakes({ gitleaks: CLEAN, tsc: { exit: 2, stdout: tsc(3).stdout + 'error TS6053: File not found.\n' } });   // located + global
  assert.strictEqual(gate(r, bin).code, 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { tsc: 40 });
  assert.strictEqual(git(r, 'diff', '--cached', '--name-only', '--', '.gate-baseline.json').stdout, '');
});

test('pyright: non-zero exit with 0 counted is exit 2 (no ratchet down to 0)', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: { exit: 1, stdout: JSON.stringify({ summary: { errorCount: 0 } }) } });
  assert.strictEqual(gate(r, bin).code, 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 3 });
});

test('pathspec commit (`git commit -- <file>`): ratchet rewrite deferred, index and HEAD baseline untouched', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  git(r, 'commit', '-qm', 'init', '--no-verify');
  git(r, 'config', 'core.hooksPath', '.githooks');
  fs.mkdirSync(path.join(r, '.githooks'));
  fs.copyFileSync(GATE, path.join(r, '.githooks', 'pre-commit'));
  fs.writeFileSync(path.join(r, 'a.py'), 'x=2\n');
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(2) });
  const c = spawnSync('git', ['commit', '-q', '-m', 'only', '--', 'a.py'], { cwd: r, env: env(minimalPath(bin)), encoding: 'utf8' });
  assert.strictEqual(c.status, 0, c.stderr);
  assert.match(c.stderr, /baseline rewrite deferred/);
  assert.strictEqual(git(r, 'show', 'HEAD:a.py').stdout, 'x=2\n');
  assert.deepStrictEqual(JSON.parse(git(r, 'show', 'HEAD:.gate-baseline.json').stdout), { pyright: 3 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r, '.gate-baseline.json'), 'utf8')), { pyright: 3 });
  assert.strictEqual(git(r, 'status', '--porcelain').stdout.split('\n').filter(l => l.includes('.gate-baseline.json')).join(''), '');
  // a normal commit (default index) still ratchets and stages the rewrite
  fs.writeFileSync(path.join(r, 'a.py'), 'x=3\n');
  git(r, 'add', '--', 'a.py');
  const n = spawnSync('git', ['commit', '-q', '-m', 'normal'], { cwd: r, env: env(minimalPath(bin)), encoding: 'utf8' });
  assert.strictEqual(n.status, 0, n.stderr);
  assert.deepStrictEqual(JSON.parse(git(r, 'show', 'HEAD:.gate-baseline.json').stdout), { pyright: 2 });
  assert.strictEqual(git(r, 'status', '--porcelain', '--untracked-files=no').stdout, '');
});

test('partial staging: a staged lint file with unstaged changes is exit 2 naming the file', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'import os\nx = 1\n' }));
  fs.writeFileSync(path.join(r, 'a.py'), 'x = 1\n');   // stage one version, then modify again
  const bin = fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(3) });
  const res = gate(r, bin);
  assert.strictEqual(res.code, 2, res.out);
  assert.match(res.out, /a\.py has unstaged changes/);
  assert.strictEqual(calls(bin, 'ruff').length, 0);   // never linted the working-tree copy
});

test('absent stack: one log line per skipped tool', () => {
  const r = repo({ 'a.py': 'x=1\n', 'b.ts': 'let x = 1\n' });
  const res = gate(r, fakes({ gitleaks: CLEAN }));
  assert.strictEqual(res.code, 0);
  for (const t of ['ruff', 'pyright']) assert.ok(res.out.includes(`${t} skipped (no pyproject.toml at the root`), res.out);
  for (const t of ['eslint', 'tsc']) assert.ok(res.out.includes(`${t} skipped (no package.json`), res.out);
});

const realGitleaks = (() => {
  const w = spawnSync(WIN ? 'where' : 'which', ['gitleaks'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.split(/\r?\n/)[0].trim() : null;
})();
test('optional: the real gitleaks blocks a staged secret', { skip: realGitleaks ? false : 'gitleaks not installed' }, () => {
  const token = 'ghp_' + 'k8Qz3Rm2Xv7Lp9Tn4Wc6Yb1Hd5Fs0Ja2Ue8G';
  const r = repo({ 'cfg.txt': `token = "${token}"\n`, '.claude/project-profile.json': JSON.stringify({ version: 1, gate: { tools: ['gitleaks'] } }) }, ['cfg.txt']);
  assert.strictEqual(gate(r, null, [], [path.dirname(realGitleaks), path.dirname(process.execPath), GIT_DIR]).code, 1);
});

test('manifest gate_tools install lines agree with the gate HINTS (manifest sync)', () => {
  const { HINTS } = require('../pre-commit');
  const m = require('../../skills/setup/manifest.json').gate_tools;
  assert.strictEqual(m.gitleaks[WIN ? 'windows' : 'linux_mac'], HINTS.gitleaks);
  assert.strictEqual(m.ruff.install, HINTS.ruff);
  assert.strictEqual(m.pyright.install, HINTS.pyright);
});

// Q1: agents commit through the hook, so its stderr lands in model context. A pass must stay tiny.
test('quiet on green: noisy passing tools and a 30 KB pyright JSON leave < 2 KB on stderr', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const noise = 'x'.repeat(200) + '\n';
  const bigJson = JSON.stringify({ generalDiagnostics: Array.from({ length: 150 }, () => ({ severity: 'warning', message: noise })), summary: { errorCount: 3 } });
  const bin = fakes({ gitleaks: { exit: 0, stdout: noise.repeat(50) }, ruff: { exit: 0, stdout: noise.repeat(50) }, pyright: { exit: 1, stdout: bigJson } });
  const res = gate(r, bin);
  assert.strictEqual(res.code, 0, res.out);
  assert.ok(Buffer.byteLength(res.out) < 2048, `stderr is ${Buffer.byteLength(res.out)} bytes`);
  assert.match(res.out, /pyright 3 <= 3/);
});

test('failing lint: its output is shown, capped to the last 40 lines', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const out = Array.from({ length: 300 }, (_, i) => `a.py:${i + 1}:1: E999 line-${i + 1}\n`).join('');
  const res = gate(r, fakes({ gitleaks: CLEAN, ruff: { exit: 1, stdout: out }, pyright: pyright(3) }));
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /line-300\n/);
  assert.match(res.out, /line-261\n/);
  assert.doesNotMatch(res.out, /line-260\n/);
  assert.ok(Buffer.byteLength(res.out) < 4096, `stderr is ${Buffer.byteLength(res.out)} bytes`);
});

test('count-up: the count line plus at most 40 lines of error detail', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const diags = Array.from({ length: 100 }, (_, i) => ({ file: 'a.py', severity: 'error', message: `bad-${i}`, range: { start: { line: i } } }));
  const res = gate(r, fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: { exit: 1, stdout: JSON.stringify({ generalDiagnostics: diags, summary: { errorCount: 100 } }) } }));
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /pyright 100 > 3 \(baseline\)/);
  assert.match(res.out, /a\.py:1: bad-0/);
  assert.doesNotMatch(res.out, /bad-40\b/);
});

test('every gate run appends one GATE line to runtime/dispatch-sizes.log (T9 counts blocks); --init does not', () => {
  const r = repo(Object.assign({}, PY, { 'a.py': 'x=1\n' }));
  const logf = path.join(r, 'runtime', 'dispatch-sizes.log');
  assert.strictEqual(gate(r, fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(3) }), ['--init']).code, 0);
  assert.ok(!fs.existsSync(logf));
  assert.strictEqual(gate(r, fakes({ gitleaks: CLEAN, ruff: { exit: 1 }, pyright: pyright(3) })).code, 1);
  assert.strictEqual(gate(r, fakes({ gitleaks: CLEAN, ruff: CLEAN, pyright: pyright(3) })).code, 0);
  const lines = fs.readFileSync(logf, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tGATE\tpre-commit\t1\tblock$/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tGATE\tpre-commit\t0\tpass$/);
});
