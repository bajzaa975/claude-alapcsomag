#!/usr/bin/env node
'use strict';
// bajzi:gate -- the bajzi pre-commit gate. Source: bajzi/gate/pre-commit.js in the bajzi plugin;
// /bajzi:project-setup copies it verbatim to <repo>/.githooks/pre-commit. Edit the source, never the copy.
//
// Lint + secrets block on the STAGED files; pyright/tsc are project-wide and block only when their
// error count rises above the committed baseline (.gate-baseline.json, written by --init). A drop
// rewrites the baseline and stages it. Verdicts come from exit codes only (the pyright/tsc counts
// from their machine-readable output), never from console prose.
// Exit: 0 clean, 1 blocked, 2 tool error or a needed tool missing (also blocks).
// Usage: node .githooks/pre-commit [--init]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOLS = ['gitleaks', 'ruff', 'eslint', 'pyright', 'tsc'];
const HINTS = {
  gitleaks: process.platform === 'win32' ? 'winget install --id Gitleaks.Gitleaks -e' : 'brew install gitleaks (or the release binary from github.com/gitleaks/gitleaks/releases)',
  ruff: 'pip install ruff (in the repo .venv)',
  pyright: 'npm install -g pyright',
  eslint: 'npm install --save-dev eslint (in the package directory)',
  tsc: 'npm install --save-dev typescript (in the package directory)',
};
const PY = /\.py$/i;
const JS = /\.(js|jsx|ts|tsx)$/i;
const WIN = process.platform === 'win32';

const log = s => process.stderr.write('gate: ' + s + '\n');

function envPath() {
  const k = Object.keys(process.env).find(x => x.toUpperCase() === 'PATH');
  return k ? process.env[k].split(path.delimiter).filter(Boolean) : [];
}

// Project-local bins first (node_modules/.bin, .venv), then PATH.
function findTool(name, dir) {
  const dirs = [path.join(dir, 'node_modules', '.bin'), path.join(dir, '.venv', WIN ? 'Scripts' : 'bin'), ...envPath()];
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (!fs.statSync(p).isFile()) continue;
        if (!WIN) fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* next */ }
    }
  }
  return null;
}

function run(bin, args, cwd) {
  // Node refuses to spawn .cmd/.bat without a shell; quote every token for cmd.exe.
  const r = /\.(cmd|bat)$/i.test(bin)
    ? spawnSync([bin, ...args].map(a => `"${a}"`).join(' '), { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 << 20 })
    : spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '' };
}

// Split a long file list so no command line passes ~6000 chars (cmd.exe caps at 8191).
function chunks(files) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const f of files) {
    if (cur.length && len + f.length > 6000) { out.push(cur); cur = []; len = 0; }
    cur.push(f);
    len += f.length + 3;
  }
  if (cur.length) out.push(cur);
  return out;
}

function readJson(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { exists: false, value: null }; }
  try { return { exists: true, value: JSON.parse(raw.replace(/^﻿/, '')) }; } catch { return { exists: true, value: null }; }
}

function config(root) {
  const prof = readJson(path.join(root, '.claude', 'project-profile.json'));
  if (prof.exists && prof.value === null) throw new Error('.claude/project-profile.json is not valid JSON');
  const g = prof.value ? prof.value.gate : undefined;
  if (g === undefined) return { tools: new Set(TOOLS), baseline: '.gate-baseline.json' };
  if (!g || typeof g !== 'object' || !Array.isArray(g.tools) || g.tools.some(t => !TOOLS.includes(t))) {
    throw new Error('.claude/project-profile.json "gate" is invalid (run /bajzi:project-setup --check)');
  }
  return { tools: new Set(g.tools), baseline: typeof g.baseline === 'string' ? g.baseline : '.gate-baseline.json' };
}

// The repo root and its immediate subdirectories that carry `marker`.
function projects(root, marker) {
  const dirs = [''];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') dirs.push(e.name);
  }
  return dirs.filter(d => fs.existsSync(path.join(root, d, marker)));
}

// Each staged file goes to the deepest project dir that contains it; paths become dir-relative.
function assign(files, dirs) {
  const map = new Map(dirs.map(d => [d, []]));
  for (const f of files) {
    const owner = dirs.filter(d => d === '' || f.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0];
    if (owner !== undefined) map.get(owner).push(owner ? f.slice(owner.length + 1) : f);
  }
  return map;
}

function missing(name) {
  log(`${name} is needed by this repo but not installed. Install: ${HINTS[name]}`);
  return 2;
}

function lint(name, args, root, dir, files) {
  if (!files.length) return 0;
  const cwd = path.join(root, dir);
  const bin = findTool(name, cwd);
  if (!bin) return missing(name);
  let worst = 0;
  for (const part of chunks(files)) {
    const { code } = run(bin, [...args, '--', ...part], cwd);
    const res = code === 0 ? 0 : code === 1 ? 1 : 2;
    if (res) log(`${name} ${res === 1 ? 'found errors' : `failed (exit ${code})`} in ${dir || '.'}`);
    worst = Math.max(worst, res);
  }
  return worst;
}

// Project-wide error count, or {err} on a missing tool / tool failure.
function count(name, root, dir) {
  const cwd = path.join(root, dir);
  const bin = findTool(name, cwd);
  if (!bin) return { err: missing(name) };
  let n;
  let code;
  if (name === 'pyright') {
    const r = run(bin, ['--outputjson'], cwd);
    code = r.code;
    try { n = JSON.parse(r.stdout).summary.errorCount; } catch { n = undefined; }
    if (code > 1) n = undefined;
  } else {
    const r = run(bin, ['--noEmit', '--pretty', 'false'], cwd);
    code = r.code;
    n = (r.stdout.match(/^.*error TS\d+:/gm) || []).length;
  }
  if (!Number.isInteger(n) || (code !== 0 && n === 0)) {
    log(`${name} failed in ${dir || '.'} (exit ${code}, no readable error count)`);
    return { err: 2 };
  }
  return { n };
}

function stagedFiles(root) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git diff --cached failed');
  return r.stdout.split('\0').filter(Boolean);
}

// The ratchet tools in scope: pyright per pyproject.toml dir, tsc per package.json dir with a tsconfig.json.
function ratchetScope(root, cfg) {
  const out = [];
  if (cfg.tools.has('pyright')) for (const d of projects(root, 'pyproject.toml')) out.push(['pyright', d]);
  if (cfg.tools.has('tsc')) for (const d of projects(root, 'package.json')) if (fs.existsSync(path.join(root, d, 'tsconfig.json'))) out.push(['tsc', d]);
  return out;
}

// Sum the counts per tool; {err} if any run failed.
function counts(root, cfg) {
  const sums = {};
  let err = 0;
  for (const [name, dir] of ratchetScope(root, cfg)) {
    const c = count(name, root, dir);
    if (c.err) err = Math.max(err, c.err);
    else sums[name] = (sums[name] || 0) + c.n;
  }
  return { sums, err };
}

function writeBaseline(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function main(argv) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) { log('not inside a git work tree'); return 2; }
  const root = top.stdout.trim();
  const cfg = config(root);
  const baseFile = path.join(root, cfg.baseline);

  if (argv.includes('--init')) {
    const { sums, err } = counts(root, cfg);
    if (err) return err;
    writeBaseline(baseFile, sums);
    log(`wrote ${cfg.baseline} ${JSON.stringify(sums)}; commit it`);
    return 0;
  }

  let worst = 0;
  const files = stagedFiles(root);
  if (cfg.tools.has('gitleaks')) {
    const bin = findTool('gitleaks', root);
    if (!bin) worst = Math.max(worst, missing('gitleaks'));
    else {
      const { code } = run(bin, ['protect', '--staged', '--redact', '--no-banner'], root);
      if (code !== 0) { log(`gitleaks: exit ${code} (a hit or a failure)`); worst = Math.max(worst, code === 1 ? 1 : 2); }
    }
  }
  if (cfg.tools.has('ruff')) {
    for (const [d, list] of assign(files.filter(f => PY.test(f)), projects(root, 'pyproject.toml'))) worst = Math.max(worst, lint('ruff', ['check'], root, d, list));
  }
  if (cfg.tools.has('eslint')) {
    for (const [d, list] of assign(files.filter(f => JS.test(f)), projects(root, 'package.json'))) worst = Math.max(worst, lint('eslint', [], root, d, list));
  }

  const scope = ratchetScope(root, cfg);
  if (scope.length) {
    const base = readJson(baseFile);
    if (!base.value || typeof base.value !== 'object') {
      log(`${cfg.baseline} is missing or unreadable; run: node .githooks/pre-commit --init, then commit it`);
      return 2;
    }
    const { sums, err } = counts(root, cfg);
    worst = Math.max(worst, err);
    let dropped = false;
    for (const [name, n] of Object.entries(sums)) {
      const b = base.value[name];
      if (!Number.isInteger(b)) { log(`${cfg.baseline} has no "${name}" count; run --init`); worst = Math.max(worst, 2); continue; }
      if (n > b) { log(`${name}: ${n} errors > baseline ${b}`); worst = Math.max(worst, 1); }
      else if (n < b) { log(`${name}: ${n} errors < baseline ${b}; ratchet down`); dropped = true; }
    }
    if (worst === 0 && dropped) {
      writeBaseline(baseFile, Object.assign({}, base.value, sums));
      const add = spawnSync('git', ['add', '--', cfg.baseline], { cwd: root });
      if (add.status !== 0) { log(`git add ${cfg.baseline} failed`); return 2; }
    }
  }
  if (worst) log(worst === 1 ? 'BLOCKED' : 'BLOCKED (tool error)');
  return worst;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { log('error: ' + e.message); process.exitCode = 2; }
}

module.exports = { TOOLS, HINTS, main };
