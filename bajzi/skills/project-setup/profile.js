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
const KEYS = new Set(['version', 'methodology', 'plugins', 'mcpServers', 'skills', 'instructions', 'gate', 'size', 'hosting']);
const METHODOLOGIES = new Set(['superpowers', 'gsd', 'none']);
const BLOCK_BEGIN = '<!-- bajzi:project-setup instructions begin -->';
const BLOCK_END = '<!-- bajzi:project-setup instructions end -->';
const GATE_SRC = path.join(__dirname, '..', '..', 'gate', 'pre-commit.js');
const GATE_DEST = path.join('.githooks', 'pre-commit');
const GATE_MARKER = 'bajzi:gate';
const GATE_TOOLS = require(GATE_SRC).TOOLS;
const PREPUSH_SRC = path.join(__dirname, '..', '..', 'gate', 'pre-push.js');
const PREPUSH_DEST = path.join('.githooks', 'pre-push');
const PREPUSH_MARKER = 'bajzi:pre-push';
const kit = require('./kit');
const RUNTIME_IGNORES = new Set(['runtime', 'runtime/', '/runtime', '/runtime/']);

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
  if ('size' in profile && !kit.SIZES.includes(profile.size)) errors.push('"size" must be XS, S, M or L');
  if ('hosting' in profile && profile.hosting !== 'local' && profile.hosting !== 'github') errors.push('"hosting" must be local or github');
  if ('size' in profile && !('hosting' in profile)) errors.push('"size" needs "hosting" (local or github)');
  if ((profile.size === 'M' || profile.size === 'L') && !('gate' in profile)) errors.push(`size ${profile.size} needs the "gate" key (the pre-commit gate is part of the M kit)`);
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

// Replace the begin..end block in place, or append it when absent; text outside stays byte-identical.
// The LAST begin marker is paired with the next end after it, so a damaged earlier block (end marker
// lost) is left alone instead of cutting the owner text up to a later block's end.
function replaceBlock(text, begin, end, block) {
  const i = text.lastIndexOf(begin);
  const j = i >= 0 ? text.indexOf(end, i) : -1;
  if (j > i) return text.slice(0, i) + block + text.slice(j + end.length);
  return (text && !text.endsWith('\n') ? text + '\n' : text) + block + '\n';
}

const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const norm = t => t.replace(/\r\n/g, '\n');

// The git work-tree toplevel containing repoRoot, '' when repoRoot is not inside one, or null when
// git itself failed (not on PATH, dubious-ownership refusal, ...). The C locale keeps git's
// "not a git repository" message untranslated so the match below holds under any locale.
function gitTop(repoRoot) {
  const env = Object.assign({}, process.env, { LC_ALL: 'C', LANGUAGE: 'C' });
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  if (r.status === 0) return r.stdout.trim();
  return !r.error && /not a git repository/i.test(r.stderr || '') ? '' : null;
}

function sameDir(a, b) {
  try { return samePath(fs.realpathSync.native(a), fs.realpathSync.native(b)); } catch { return samePath(a, b); }
}

function plan(profile, repoRoot, { home = os.homedir() } = {}) {
  const actions = [];
  const init = Boolean(profile.size || profile.hosting) && gitTop(repoRoot) === '';
  if (init) actions.push({ kind: 'git-init', target: '.' });
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
  if (profile.size) {
    const cur = readText(path.join(repoRoot, '.claude', 'CLAUDE.md')) || '';
    if (!norm(cur).includes(kit.sizeBlock(profile.size, profile.hosting))) actions.push({ kind: 'kit', target: '.claude/CLAUDE.md' });
    for (const f of kit.scaffold(profile.size)) {
      if (!fs.existsSync(path.join(repoRoot, f.rel))) actions.push({ kind: 'scaffold', target: f.rel, text: f.text });
    }
    const gi = readText(path.join(repoRoot, '.gitignore')) || '';
    if (profile.size !== 'XS' && !gi.split(/\r?\n/).some(l => RUNTIME_IGNORES.has(l.trim()))) actions.push({ kind: 'gitignore', target: '.gitignore' });
  }
  const prepush = profile.hosting === 'local';
  if ((profile.gate || prepush) && !init) {   // git-init sets core.hooksPath itself
    const hp = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    const cur = hp.status === 0 ? hp.stdout.trim().replace(/[\\/]+$/, '') : '';
    if (cur !== '.githooks') actions.push({ kind: 'hookspath', target: 'core.hooksPath', value: cur });
  }
  if (profile.gate) {
    const have = readText(path.join(repoRoot, GATE_DEST));
    if (have === null || norm(have) !== norm(fs.readFileSync(GATE_SRC, 'utf8'))) actions.push({ kind: 'gate', target: '.githooks/pre-commit' });
    // A tracked hook must be 100755 in the index, or a Linux/mac checkout silently skips it
    // (a Windows `git add` stages 100644: chmod never reaches the index there).
    const m = indexMode(repoRoot, '.githooks/pre-commit');
    if (m && m !== '100755') actions.push({ kind: 'gate-mode', target: '.githooks/pre-commit' });
  }
  if (prepush) {   // never removed later: the hook itself reads "hosting" at push time
    const have = readText(path.join(repoRoot, PREPUSH_DEST));
    if (have === null || norm(have) !== norm(fs.readFileSync(PREPUSH_SRC, 'utf8'))) actions.push({ kind: 'prepush', target: '.githooks/pre-push' });
    const m = indexMode(repoRoot, '.githooks/pre-push');
    if (m && m !== '100755') actions.push({ kind: 'prepush-mode', target: '.githooks/pre-push' });
  }
  if (profile.size === 'L' && profile.hosting === 'github') {   // report-only: bajzi never writes .github/
    let ents = [];
    try { ents = fs.readdirSync(path.join(repoRoot, '.github', 'workflows'), { withFileTypes: true }); } catch { ents = []; }
    if (!ents.some(e => e.isFile() && /\.ya?ml$/.test(e.name))) actions.push({ kind: 'kit-ci', target: '.github/workflows' });
  }
  return actions;
}

// The index mode of a tracked file ('100755', '100644'), or '' when untracked / not a repo.
function indexMode(repoRoot, rel) {
  const r = spawnSync('git', ['ls-files', '-s', '--', rel], { cwd: repoRoot, encoding: 'utf8' });
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
  if (profile.size || profile.hosting) {
    const top = gitTop(repoRoot);
    if (top === null) errors.push(`git could not run in ${repoRoot} (not on PATH, or it refused the folder); fix git first`);
    else if (top && !sameDir(top, repoRoot)) errors.push(`${repoRoot} is inside the git repo ${top}; run project-setup at the repo root`);
  }
  const hp = actions.find(a => a.kind === 'hookspath');
  if (hp) errors.push(`core.hooksPath is "${hp.value}", the ${profile.gate ? 'gate needs' : 'pre-push hook needs'} ".githooks"; run: git config core.hooksPath .githooks`);
  if (actions.some(a => a.kind === 'gate')) {
    let cur = null;
    try { cur = fs.readFileSync(path.join(repoRoot, GATE_DEST), 'utf8'); } catch { cur = null; }
    if (cur !== null && !cur.includes(GATE_MARKER)) errors.push('.githooks/pre-commit exists and is not the bajzi gate; move it away first');
  }
  if (actions.some(a => a.kind === 'prepush')) {
    const cur = readText(path.join(repoRoot, PREPUSH_DEST));
    if (cur !== null && !cur.includes(PREPUSH_MARKER)) errors.push('.githooks/pre-push exists and is not the bajzi hosting guard; move it away first');
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
  const all = plan(profile, repoRoot, { home });
  const todo = all.filter(a => a.kind === 'kit-ci');
  const actions = all.filter(a => a.kind !== 'kit-ci');
  const errors = preflight(profile, repoRoot, actions);
  if (errors.length) throw new ProfileError(errors);
  const failures = [];
  if (actions.some(a => a.kind === 'git-init')) {
    for (const args of [['init', '-q'], ['config', 'core.hooksPath', '.githooks']]) {
      const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
      if (r.status !== 0) failures.push(`git-init: git ${args[0]} exited ${r.status}`);
    }
  }
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
  const doInstr = actions.some(a => a.kind === 'instructions');
  const doKit = actions.some(a => a.kind === 'kit');
  if (doInstr || doKit) {   // one read-modify-write: each block replaced in place, owner text kept
    const file = path.join(repoRoot, '.claude', 'CLAUDE.md');
    let cur = readText(file) || '';
    if (doInstr) cur = replaceBlock(cur, BLOCK_BEGIN, BLOCK_END, instructionBlock(profile.instructions));
    if (doKit) cur = replaceBlock(cur, kit.KIT_BEGIN, kit.KIT_END, kit.sizeBlock(profile.size, profile.hosting));
    writeAtomic(file, cur);
  }
  for (const a of actions.filter(x => x.kind === 'scaffold')) {
    const dest = path.join(repoRoot, a.target);
    if (!fs.existsSync(dest)) writeAtomic(dest, a.text);   // create only; never overwrite
  }
  if (actions.some(a => a.kind === 'gitignore')) {
    const file = path.join(repoRoot, '.gitignore');
    const cur = readText(file) || '';
    const nl = cur.includes('\r\n') ? '\r\n' : '\n';
    writeAtomic(file, (cur && !cur.endsWith('\n') ? cur + nl : cur) + 'runtime/' + nl);
  }
  for (const [kind, src, dest] of [['gate', GATE_SRC, GATE_DEST], ['prepush', PREPUSH_SRC, PREPUSH_DEST]]) {
    if (!actions.some(a => a.kind === kind)) continue;
    writeAtomic(path.join(repoRoot, dest), fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'));
    fs.chmodSync(path.join(repoRoot, dest), 0o755);
  }
  // A tracked hook gets index mode 100755 (a Windows `git add` stages 100644).
  for (const [kind, rel] of [['gate', '.githooks/pre-commit'], ['prepush', '.githooks/pre-push']]) {
    if (!actions.some(a => a.kind === kind || a.kind === kind + '-mode') || !indexMode(repoRoot, rel)) continue;
    const r = spawnSync('git', ['update-index', '--chmod=+x', '--', rel], { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) failures.push(`${kind}-mode: git update-index --chmod=+x exited ${r.status}`);
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
  return { applied: actions, todo, failures };
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
    for (const a of r.todo) out(`TODO ${a.kind} ${a.target}: write a CI workflow that runs this repo's tests (see /bajzi:project-setup)`);
    if (!r.applied.length && !r.todo.length) out('project-setup: already in the profile state');
    return r.failures.length ? 1 : 0;
  } catch (e) {
    if (e instanceof ProfileError) { for (const x of e.errors) out('project-setup: REFUSED: ' + x); return 2; }
    throw e;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { validate, plan, apply, check, main, ProfileError, SUPPORTED_VERSION };
