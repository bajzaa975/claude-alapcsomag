#!/usr/bin/env node
'use strict';
// /bajzi:project-setup: apply or check the repo's .claude/project-profile.json (schema v1).
// Project data lives in the repo; bajzi supplies only this mechanism. An invalid profile or a
// failed preflight check writes NOTHING. File changes happen first; `claude plugin` calls last,
// and a failed call is reported without undoing the (already consistent) file changes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUPPORTED_VERSION = 1;
const KEYS = new Set(['version', 'methodology', 'plugins', 'mcpServers', 'skills', 'instructions', 'gate']);
const METHODOLOGIES = new Set(['superpowers', 'gsd', 'none']);
const BLOCK_BEGIN = '<!-- bajzi:project-setup instructions begin -->';
const BLOCK_END = '<!-- bajzi:project-setup instructions end -->';
const GATE_SRC = path.join(__dirname, '..', '..', 'gate', 'pre-commit.js');
const GATE_DEST = path.join('.githooks', 'pre-commit');
const GATE_MARKER = 'bajzi:gate';
const GATE_TOOLS = require(GATE_SRC).TOOLS;

class ProfileError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function relOk(p) {
  return typeof p === 'string' && p.trim() !== '' && !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p)
    && !p.replace(/\\/g, '/').split('/').includes('..');
}

function validate(profile) {
  if (!isObj(profile)) return { ok: false, errors: ['profile must be a JSON object'] };
  const errors = [];
  for (const k of Object.keys(profile)) if (!KEYS.has(k)) errors.push(`unknown key "${k}"`);
  if ('version' in profile && profile.version !== SUPPORTED_VERSION) {
    if (Number.isInteger(profile.version) && profile.version > SUPPORTED_VERSION) {
      errors.push(`profile version ${profile.version} is newer than this bajzi supports (${SUPPORTED_VERSION}); update the bajzi plugin`);
    } else {
      errors.push(`"version" must be ${SUPPORTED_VERSION}`);
    }
  }
  if ('methodology' in profile && !METHODOLOGIES.has(profile.methodology)) errors.push('"methodology" must be superpowers, gsd or none');
  if ('plugins' in profile) {
    if (!Array.isArray(profile.plugins)) errors.push('"plugins" must be an array');
    else profile.plugins.forEach((p, i) => {
      if (!isObj(p)) { errors.push(`plugins[${i}] must be an object`); return; }
      for (const k of Object.keys(p)) if (k !== 'id' && k !== 'marketplace') errors.push(`plugins[${i}]: unknown key "${k}"`);
      if (typeof p.id !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(p.id)) errors.push(`plugins[${i}].id must look like name@marketplace`);
      if ('marketplace' in p && (typeof p.marketplace !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(p.marketplace))) errors.push(`plugins[${i}].marketplace must look like owner/repo`);
    });
  }
  if ('mcpServers' in profile) {
    if (!isObj(profile.mcpServers)) errors.push('"mcpServers" must be an object');
    else for (const [name, s] of Object.entries(profile.mcpServers)) {
      if (!isObj(s)) { errors.push(`mcpServers.${name} must be an object`); continue; }
      const remote = s.type === 'http' || s.type === 'sse';
      if (remote ? typeof s.url !== 'string' : (typeof s.command !== 'string' || !s.command)) errors.push(`mcpServers.${name} needs ${remote ? 'a url' : 'a command'}`);
      if ('args' in s && (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string'))) errors.push(`mcpServers.${name}.args must be an array of strings`);
      if ('env' in s && (!isObj(s.env) || Object.values(s.env).some(v => typeof v !== 'string'))) errors.push(`mcpServers.${name}.env must map names to strings`);
    }
  }
  for (const key of ['skills', 'instructions']) {
    if (!(key in profile)) continue;
    if (!Array.isArray(profile[key])) errors.push(`"${key}" must be an array`);
    else profile[key].forEach((p, i) => { if (!relOk(p)) errors.push(`${key}[${i}] must be a relative path inside the repo`); });
  }
  if ('gate' in profile) {
    const g = profile.gate;
    if (!isObj(g)) errors.push('"gate" must be an object');
    else {
      for (const k of Object.keys(g)) if (k !== 'tools' && k !== 'baseline') errors.push(`gate: unknown key "${k}"`);
      if (!Array.isArray(g.tools) || !g.tools.length || g.tools.some(t => !GATE_TOOLS.includes(t)) || new Set(g.tools).size !== g.tools.length) {
        errors.push(`gate.tools must be a non-empty list of distinct names from ${GATE_TOOLS.join(', ')}`);
      }
      if ('baseline' in g && !relOk(g.baseline)) errors.push('gate.baseline must be a relative path inside the repo');
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

function readJsonFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { exists: false, value: null, error: null }; }
  try { return { exists: true, value: JSON.parse(raw.replace(/^\uFEFF/, '')), error: null }; } catch (e) { return { exists: true, value: null, error: e.message }; }
}

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function samePath(a, b) {
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function instructionBlock(list) {
  return [BLOCK_BEGIN, ...list.map(rel => '@../' + rel.replace(/\\/g, '/')), BLOCK_END].join('\n');
}

function plan(profile, repoRoot, { home = os.homedir() } = {}) {
  const actions = [];
  if (profile.methodology) {
    let cur = null;
    try { cur = fs.readFileSync(path.join(repoRoot, '.claude', 'METHODOLOGY'), 'utf8').trim(); } catch { cur = null; }
    if (cur !== profile.methodology) actions.push({ kind: 'methodology', target: '.claude/METHODOLOGY', value: profile.methodology });
  }
  if (profile.mcpServers) {
    const mcp = readJsonFile(path.join(repoRoot, '.mcp.json'));
    const have = mcp.value && isObj(mcp.value.mcpServers) ? mcp.value.mcpServers : {};
    for (const [name, def] of Object.entries(profile.mcpServers)) {
      if (canon(have[name]) !== canon(def)) actions.push({ kind: 'mcp', target: `.mcp.json:${name}`, name, def });
    }
  }
  if (profile.plugins && profile.plugins.length) {
    const km = readJsonFile(path.join(home, '.claude', 'plugins', 'known_marketplaces.json')).value;
    const repos = isObj(km) ? Object.values(km).map(m => String((m && m.source && (m.source.repo || m.source.url)) || '').toLowerCase()) : [];
    const ip = readJsonFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json')).value;
    const pl = ip && isObj(ip.plugins) ? ip.plugins : {};
    const seen = new Set();
    for (const p of profile.plugins) {
      if (p.marketplace && !seen.has(p.marketplace.toLowerCase())) {
        const w = p.marketplace.toLowerCase();
        seen.add(w);
        if (!repos.some(r => r === w || r.endsWith('/' + w) || r.endsWith('/' + w + '.git'))) actions.push({ kind: 'marketplace', target: p.marketplace });
      }
      const entries = Array.isArray(pl[p.id]) ? pl[p.id] : [];
      if (!entries.some(e => e && e.scope === 'project' && samePath(e.projectPath, repoRoot))) actions.push({ kind: 'plugin', target: p.id });
    }
  }
  for (const rel of profile.skills || []) {
    const name = path.basename(rel.replace(/\\/g, '/'));
    const dest = path.join(repoRoot, '.claude', 'skills', name);
    let ok = false;
    try { ok = fs.realpathSync(dest) === fs.realpathSync(path.join(repoRoot, rel)); } catch { ok = false; }
    if (!ok) actions.push({ kind: 'skill', target: `.claude/skills/${name}`, src: rel, name });
  }
  if (profile.instructions && profile.instructions.length) {
    let cur = '';
    try { cur = fs.readFileSync(path.join(repoRoot, '.claude', 'CLAUDE.md'), 'utf8'); } catch { cur = ''; }
    if (!cur.includes(instructionBlock(profile.instructions))) actions.push({ kind: 'instructions', target: '.claude/CLAUDE.md' });
  }
  if (profile.gate) {
    const hp = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    const cur = hp.status === 0 ? hp.stdout.trim().replace(/[\\/]+$/, '') : '';
    if (cur !== '.githooks') actions.push({ kind: 'gate-hookspath', target: 'core.hooksPath', value: cur });
    const norm = t => t.replace(/\r\n/g, '\n');
    let have = null;
    try { have = fs.readFileSync(path.join(repoRoot, GATE_DEST), 'utf8'); } catch { have = null; }
    if (have === null || norm(have) !== norm(fs.readFileSync(GATE_SRC, 'utf8'))) actions.push({ kind: 'gate', target: '.githooks/pre-commit' });
    // A tracked hook must be 100755 in the index, or a Linux/mac checkout silently skips it
    // (a Windows `git add` stages 100644: chmod never reaches the index there).
    const m = gateIndexMode(repoRoot);
    if (m && m !== '100755') actions.push({ kind: 'gate-mode', target: '.githooks/pre-commit' });
  }
  return actions;
}

// The index mode of the tracked gate hook ('100755', '100644'), or '' when untracked / not a repo.
function gateIndexMode(repoRoot) {
  const r = spawnSync('git', ['ls-files', '-s', '--', '.githooks/pre-commit'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(' ')[0].trim() : '';
}

function preflight(profile, repoRoot, actions) {
  const errors = [];
  const mcp = readJsonFile(path.join(repoRoot, '.mcp.json'));
  if (actions.some(a => a.kind === 'mcp') && mcp.error) errors.push(`.mcp.json is not valid JSON (${mcp.error}); fix it first`);
  for (const a of actions.filter(x => x.kind === 'skill')) {
    const src = path.join(repoRoot, a.src);
    let isDir = false;
    try { isDir = fs.statSync(src).isDirectory(); } catch { isDir = false; }
    if (!isDir) errors.push(`skill source ${a.src} does not exist or is not a directory`);
    const dest = path.join(repoRoot, '.claude', 'skills', a.name);
    let st = null;
    try { st = fs.lstatSync(dest); } catch { st = null; }
    if (st && !st.isSymbolicLink()) errors.push(`${a.target} exists and is not a link to ${a.src}; move it away first`);
  }
  for (const rel of profile.instructions || []) {
    let isFile = false;
    try { isFile = fs.statSync(path.join(repoRoot, rel)).isFile(); } catch { isFile = false; }
    if (!isFile) errors.push(`instruction file ${rel} does not exist`);
  }
  const hp = actions.find(a => a.kind === 'gate-hookspath');
  if (hp) errors.push(`core.hooksPath is "${hp.value}", the gate needs ".githooks"; run: git config core.hooksPath .githooks`);
  if (actions.some(a => a.kind === 'gate')) {
    let cur = null;
    try { cur = fs.readFileSync(path.join(repoRoot, GATE_DEST), 'utf8'); } catch { cur = null; }
    if (cur !== null && !cur.includes(GATE_MARKER)) errors.push('.githooks/pre-commit exists and is not the bajzi gate; move it away first');
  }
  return errors;
}

function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function runClaude(args, cwd) {
  const r = spawnSync('claude', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === null ? 1 : r.status;
}

function apply(profile, repoRoot, { home = os.homedir(), run = runClaude } = {}) {
  const v = validate(profile);
  if (!v.ok) throw new ProfileError(v.errors);
  const actions = plan(profile, repoRoot, { home });
  const errors = preflight(profile, repoRoot, actions);
  if (errors.length) throw new ProfileError(errors);
  const failures = [];
  for (const a of actions) {
    if (a.kind === 'methodology') writeAtomic(path.join(repoRoot, '.claude', 'METHODOLOGY'), a.value + '\n');
  }
  const mcpActs = actions.filter(a => a.kind === 'mcp');
  if (mcpActs.length) {
    const file = path.join(repoRoot, '.mcp.json');
    const cur = readJsonFile(file).value;
    const doc = isObj(cur) ? cur : {};
    if (!isObj(doc.mcpServers)) doc.mcpServers = {};
    for (const a of mcpActs) doc.mcpServers[a.name] = a.def;
    writeAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  }
  for (const a of actions.filter(x => x.kind === 'skill')) {
    const dest = path.join(repoRoot, '.claude', 'skills', a.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest); } catch { /* not there */ }
    fs.symlinkSync(path.resolve(repoRoot, a.src), dest, 'junction');
  }
  if (actions.some(a => a.kind === 'instructions')) {
    const file = path.join(repoRoot, '.claude', 'CLAUDE.md');
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = ''; }
    const i = cur.indexOf(BLOCK_BEGIN);
    const j = cur.indexOf(BLOCK_END);
    if (i >= 0 && j > i) cur = cur.slice(0, i) + cur.slice(j + BLOCK_END.length).replace(/^\n/, '');
    const base = cur && !cur.endsWith('\n') ? cur + '\n' : cur;
    writeAtomic(file, base + instructionBlock(profile.instructions) + '\n');
  }
  if (actions.some(a => a.kind === 'gate')) {
    const dest = path.join(repoRoot, GATE_DEST);
    writeAtomic(dest, fs.readFileSync(GATE_SRC, 'utf8').replace(/\r\n/g, '\n'));
    fs.chmodSync(dest, 0o755);
  }
  if (actions.some(a => a.kind === 'gate' || a.kind === 'gate-mode') && gateIndexMode(repoRoot)) {
    const r = spawnSync('git', ['update-index', '--chmod=+x', '--', '.githooks/pre-commit'], { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) failures.push(`gate-mode: git update-index --chmod=+x exited ${r.status}`);
  }
  for (const a of actions) {
    if (a.kind === 'marketplace') {
      const code = run(['plugin', 'marketplace', 'add', a.target], repoRoot);
      if (code !== 0) failures.push(`marketplace ${a.target}: claude exited ${code}`);
    } else if (a.kind === 'plugin') {
      const code = run(['plugin', 'install', a.target, '--scope', 'project'], repoRoot);
      if (code !== 0) failures.push(`plugin ${a.target}: claude exited ${code}`);
    }
  }
  return { applied: actions, failures };
}

function check(profile, repoRoot, { home = os.homedir() } = {}) {
  return plan(profile, repoRoot, { home }).map(a => `DRIFT ${a.kind} ${a.target}`);
}

function main(argv = process.argv.slice(2), env = process.env) {
  const out = s => process.stdout.write(s + '\n');
  const ri = argv.indexOf('--repo');
  const repo = path.resolve(ri >= 0 && argv[ri + 1] ? argv[ri + 1] : process.cwd());
  const home = env.BAJZI_HOME || os.homedir();
  const file = path.join(repo, '.claude', 'project-profile.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    out(`project-setup: no .claude/project-profile.json in ${repo}; nothing to do`);
    return 0;
  }
  let profile;
  try { profile = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) {
    out(`project-setup: REFUSED: ${file} is not valid JSON (${e.message})`);
    return 2;
  }
  const v = validate(profile);
  if (!v.ok) { for (const e of v.errors) out('project-setup: REFUSED: ' + e); return 2; }
  if (argv.includes('--check')) {
    const lines = check(profile, repo, { home });
    lines.forEach(out);
    out(lines.length ? `project-setup --check: ${lines.length} drift item(s)` : 'project-setup --check: clean');
    return lines.length ? 1 : 0;
  }
  if (argv.includes('--dry-run')) {
    for (const a of plan(profile, repo, { home })) out(`WOULD ${a.kind} ${a.target}`);
    return 0;
  }
  try {
    const r = apply(profile, repo, { home });
    for (const a of r.applied) out(`APPLIED ${a.kind} ${a.target}`);
    for (const f of r.failures) out(`FAILED ${f}`);
    if (!r.applied.length) out('project-setup: already in the profile state');
    return r.failures.length ? 1 : 0;
  } catch (e) {
    if (e instanceof ProfileError) { for (const x of e.errors) out('project-setup: REFUSED: ' + x); return 2; }
    throw e;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { validate, plan, apply, check, main, ProfileError, SUPPORTED_VERSION };
