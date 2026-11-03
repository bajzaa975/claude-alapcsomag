'use strict';
// file-lock.js: the cross-session same-file edit guard (spec §6.21). Temp git repos, BAJZI_STATUS_DIR temp.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_DIR, tmpDir, runScript, p95 } = require('./helpers');
const fl = require('../file-lock.js');

const PRE = path.join(NODE_DIR, 'pre-tool.js');
const LOCK_JS = path.join(NODE_DIR, 'file-lock.js');
const PERF = process.env.BAJZI_PERF === '1' ? {} : { skip: 'latency budget: set BAJZI_PERF=1' };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

function repo() {
  const d = fs.realpathSync(tmpDir('bajzi-fl-'));
  git(d, 'init', '-q');
  return d;
}
const edit = (cwd, file, sid, tool = 'Edit', extra = {}) => Object.assign({
  session_id: sid, hook_event_name: 'PreToolUse', tool_name: tool, cwd,
  tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file },
}, extra);
const env = (status, extra = {}) => Object.assign({ BAJZI_STATUS_DIR: status, CLAUDE_PID: undefined, BAJZI_LOCK_OWNER: undefined }, extra);
const locksOf = r => { const d = path.join(r, '.git', 'bajzi', 'file-locks'); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : []; };
const lockPath = r => path.join(r, '.git', 'bajzi', 'file-locks', locksOf(r)[0]);
const denyOf = r => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);
const pre = (input, e) => runScript(PRE, JSON.stringify(input), e);
const age = (p, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(p, t, t); };

test('two owners, same file: the second is denied and the holder is named', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  fs.writeFileSync(path.join(st, 'aaaaaaaa-long.line.json'), JSON.stringify({ session_name: 'night' }));
  assert.equal(pre(edit(r, 'x.js', 'aaaaaaaa-long'), env(st)).stdout, '');
  const o = denyOf(pre(edit(r, 'x.js', 'bbbbbbbb-long'), env(st)));
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /^\[bajzi:file-lock\] x\.js is being edited by another Claude session night \(.+, .+, last edit 0 min ago\)\. Wait for its turn to end; if that session is gone, delete .+\.json\.$/);
  const o2 = denyOf(pre(edit(r, 'x.js', 'cccccccc-long'), env(tmpDir('bajzi-st-'))));
  assert.match(o2.permissionDecisionReason, /session aaaaaaaa \(/);   // no session_name: first 8 chars of the owner
});

test('different files both pass; the same owner with another agent_id passes; NotebookEdit uses notebook_path', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  assert.equal(pre(edit(r, 'x.js', 'A'), env(st)).stdout, '');
  assert.equal(pre(edit(r, 'y.js', 'B'), env(st)).stdout, '');
  assert.equal(pre(edit(r, 'x.js', 'A', 'Edit', { agent_id: 'sub1' }), env(st)).stdout, '');
  assert.equal(pre(edit(r, 'n.ipynb', 'A', 'NotebookEdit'), env(st)).stdout, '');
  assert.notEqual(pre(edit(r, 'n.ipynb', 'B', 'NotebookEdit'), env(st)).stdout, '');
  assert.equal(pre(edit(r, 'X.JS', 'A'), env(st)).stdout, '');   // lower-cased key: the same lock as x.js
  assert.equal(locksOf(r).length, 3);   // x.js (= X.JS), y.js, n.ipynb
});

test('paths inside .git, outside any repo and non-edit tools take no lock', () => {
  const r = repo(), st = tmpDir('bajzi-st-'), out = tmpDir('bajzi-out-');
  assert.equal(pre(edit(r, '.git/config', 'A'), env(st)).stdout, '');
  assert.equal(pre(edit(r, '.git/config', 'B'), env(st)).stdout, '');
  assert.equal(pre(edit(out, 'z.js', 'A'), env(st)).stdout, '');
  assert.equal(pre(edit(out, 'z.js', 'B'), env(st)).stdout, '');
  assert.equal(locksOf(r).length, 0);
  assert.equal(fs.existsSync(path.join(r, '.git', 'bajzi')), false);
  for (const tool of ['Bash', 'Read']) {
    const i = { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: tool, cwd: r, tool_input: { file_path: path.join(r, 'x.js'), command: 'echo' } };
    assert.equal(pre(i, env(st)).stdout, '');
  }
  assert.equal(fs.existsSync(path.join(r, '.git', 'bajzi')), false);
});

test('the owner is BAJZI_LOCK_OWNER when set, else session_id', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  assert.equal(pre(edit(r, 'x.js', 'child1'), env(st, { BAJZI_LOCK_OWNER: 'parent' })).stdout, '');
  assert.equal(pre(edit(r, 'x.js', 'parent'), env(st)).stdout, '');   // the parent shares it
  assert.notEqual(pre(edit(r, 'x.js', 'other'), env(st)).stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(lockPath(r), 'utf8')).owner, 'parent');
});

test('record: owner, pid from CLAUDE_PID, ident, cwd, file, created; a repeat edit by the owner touches the mtime only', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  pre(edit(r, 'sub/x.js', 'A'), env(st, { CLAUDE_PID: '4242' }));
  const p = lockPath(r), rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(Object.keys(rec), ['owner', 'pid', 'ident', 'cwd', 'file', 'created']);
  assert.equal(rec.owner, 'A'); assert.equal(rec.pid, 4242); assert.equal(rec.cwd, r); assert.equal(rec.file, 'sub/x.js');
  assert.match(rec.ident, /^.+\|(linux|win32|darwin)\|/); assert.ok(!Number.isNaN(Date.parse(rec.created)));
  age(p, 5 * 60 * 1000);
  pre(edit(r, 'sub/x.js', 'A'), env(st));
  assert.ok(Date.now() - fs.statSync(p).mtimeMs < 60 * 1000);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), rec);
});

test('an mtime older than the TTL is reclaimed; a fresher one is not', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  pre(edit(r, 'x.js', 'A'), env(st));
  age(lockPath(r), fl.TTL_MS - 60 * 1000);
  assert.notEqual(pre(edit(r, 'x.js', 'B'), env(st)).stdout, '');
  age(lockPath(r), fl.TTL_MS + 1000);
  assert.equal(pre(edit(r, 'x.js', 'B'), env(st)).stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(lockPath(r), 'utf8')).owner, 'B');
  assert.equal(fs.existsSync(`${lockPath(r)}.reclaim`), false);
});

test('same ident + dead pid: reclaimed at once; different ident + dead-looking pid + fresh mtime: still denied; same ident + live pid: denied', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;   // a pid that has just exited
  pre(edit(r, 'x.js', 'A'), env(st, { CLAUDE_PID: String(dead) }));
  assert.equal(pre(edit(r, 'x.js', 'B'), env(st)).stdout, '');
  const p = lockPath(r), rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(rec.owner, 'B');
  fs.writeFileSync(p, JSON.stringify(Object.assign(rec, { owner: 'A', pid: dead, ident: `elsewhere|${process.platform}|` })));
  assert.notEqual(pre(edit(r, 'x.js', 'C'), env(st)).stdout, '');
  const mine = `${require('node:os').hostname()}|${process.platform}|${process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : ''}`;
  fs.writeFileSync(p, JSON.stringify(Object.assign(rec, { ident: mine, pid: process.pid })));
  assert.notEqual(pre(edit(r, 'x.js', 'C'), env(st)).stdout, '');
});

test('an unparseable record is foreign-live while the mtime is fresh, stale after the TTL', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  pre(edit(r, 'x.js', 'A'), env(st));
  const p = lockPath(r);
  fs.writeFileSync(p, '{not json');
  assert.notEqual(pre(edit(r, 'x.js', 'B'), env(st)).stdout, '');
  age(p, fl.TTL_MS + 1000);
  assert.equal(pre(edit(r, 'x.js', 'B'), env(st)).stdout, '');
});

test('a fresh .reclaim mutex denies at once; one older than 10 s is removed', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  pre(edit(r, 'x.js', 'A'), env(st));
  const p = lockPath(r);
  age(p, fl.TTL_MS + 1000);
  fs.mkdirSync(`${p}.reclaim`);
  const o = denyOf(pre(edit(r, 'x.js', 'B'), env(st)));
  assert.match(o.permissionDecisionReason, /retry in a moment/);
  age(`${p}.reclaim`, 11 * 1000);
  assert.equal(pre(edit(r, 'x.js', 'B'), env(st)).stdout, '');
});

test('linked worktree: the same physical file is one lock from any cwd; the same relpath in another worktree is not blocked', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  const wt = path.join(tmpDir('bajzi-wt-'), 'wt');
  git(r, 'worktree', 'add', '-q', wt);
  assert.equal(pre(edit(wt, 'x', 'A'), env(st)).stdout, '');
  assert.notEqual(pre(edit(r, path.join(wt, 'x'), 'B'), env(st)).stdout, '');   // B, cwd in main, edits <wt>/x
  assert.equal(pre(edit(r, 'x', 'B'), env(st)).stdout, '');                    // <main>/x is another physical file
  assert.equal(locksOf(r).length, 2);   // both under the COMMON dir
});

test('toLocal / parseGitFile translate the other OS gitdir (pure)', () => {
  assert.equal(fl.toLocal('/mnt/c/Users/x/.git/worktrees/w', 'win32'), 'C:/Users/x/.git/worktrees/w');
  assert.equal(fl.toLocal('/mnt/D/a', 'win32'), 'D:/a');
  assert.equal(fl.toLocal('C:/Users/x/r/.git/worktrees/w', 'linux'), '/mnt/c/Users/x/r/.git/worktrees/w');
  assert.equal(fl.toLocal('c:\\Users\\x', 'linux'), '/mnt/c/Users/x');
  assert.equal(fl.toLocal('/home/x/r', 'linux'), '/home/x/r');
  assert.equal(fl.toLocal('C:/x', 'win32'), 'C:/x');
  assert.equal(fl.parseGitFile('gitdir: C:/Users/x/r/.git/worktrees/w\n', '/mnt/c/Users/x/wt', 'linux'), '/mnt/c/Users/x/r/.git/worktrees/w');
  if (process.platform === 'win32') assert.equal(fl.parseGitFile('gitdir: /mnt/c/Users/x/r/.git/worktrees/w\n', 'C:/wt', 'win32').replace(/\\/g, '/'), 'C:/Users/x/r/.git/worktrees/w');   // path.resolve is host-native
  assert.equal(fl.parseGitFile('nothing', '/r', 'linux'), null);
});

test('a .git file with a posix gitdir resolves to the main checkout common dir and a wt: worktree id', { skip: process.platform !== 'linux' }, () => {
  const base = fs.realpathSync(tmpDir('bajzi-x-'));
  const gitdir = path.join(base, 'main', '.git', 'worktrees', 'w');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  fs.mkdirSync(path.join(base, 'wt'));
  const st = tmpDir('bajzi-st-');
  fs.writeFileSync(path.join(base, 'wt', '.git'), `gitdir: ${gitdir}\n`);
  const repo0 = fl.repoOf(path.join(base, 'wt', 'f'));
  assert.equal(repo0.common, path.join(base, 'main', '.git'));
  assert.equal(repo0.wt, 'wt:w');
  assert.equal(pre(edit(base, 'wt/f', 'A'), env(st)).stdout, '');
  assert.ok(fs.existsSync(path.join(base, 'main', '.git', 'bajzi', 'file-locks')));
  assert.notEqual(pre(edit(base, 'wt/f', 'B'), env(st)).stdout, '');
});

// N node processes call check() at the same instant (a shared start time), different owners, same file.
function racers(n, repoDir, st, ownerOf) {
  const code = `const fl=require(${JSON.stringify(LOCK_JS)});const [i,o,cwd,t]=process.argv.slice(1);
while(Date.now()<+t);
const r=fl.check({session_id:o,tool_name:'Edit',cwd,tool_input:{file_path:'x.js'}},process.env);
process.stdout.write(r?'deny':'allow');`;
  const t = Date.now() + 700;
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise(res => {
    const c = spawn(process.execPath, ['-e', code, String(i), ownerOf(i), repoDir, String(t)], { env: Object.assign({}, process.env, { BAJZI_STATUS_DIR: st, BAJZI_LOCK_OWNER: '', CLAUDE_PID: '' }) });
    let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', () => res(o));
  })));
}

test('a linked worktree whose path ends in `main` is not the main checkout (own worktree id)', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  const wt = path.join(tmpDir('bajzi-wt-'), 'main');
  git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  git(r, 'worktree', 'add', '-q', '-b', 'wt-main', wt);
  assert.equal(pre(edit(r, path.join(r, 'x'), 'A'), env(st)).stdout, '');
  assert.equal(pre(edit(r, path.join(wt, 'x'), 'B'), env(st)).stdout, '');
  assert.equal(locksOf(r).length, 2);
});

test('a headless child (BAJZI_LOCK_OWNER = parent) whose pid is gone keeps the parent lock alive', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;   // exited: its pid is gone
  assert.equal(pre(edit(r, 'x.js', 'child'), env(st, { BAJZI_LOCK_OWNER: 'PPPPPPPP', CLAUDE_PID: String(dead) })).stdout, '');
  const o = denyOf(pre(edit(r, 'x.js', 'Q'), env(st)));
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /session PPPPPPPP \(/);
});

test('a refused edit (writer-guard) leaves no lock behind, even for a file in another repo', () => {
  const a = repo(), b = repo(), st = tmpDir('bajzi-st-');
  fs.mkdirSync(path.join(b, '.claude-plugin'));
  fs.writeFileSync(path.join(b, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'bajzi-plugins' }));
  const o = denyOf(pre(edit(a, path.join(b, 'bajzi', 'f.js'), 'A'), env(st)));
  assert.match(o.permissionDecisionReason, /bajzi plugin changes/);
  assert.equal(locksOf(b).length, 0);
  fl.releaseAll({ session_id: 'A', cwd: a }, {});
  assert.equal(fl.check(edit(b, path.join(b, 'bajzi', 'f.js'), 'B'), { BAJZI_STATUS_DIR: st }), null);
});

test('RACE: 8 concurrent processes, different owners, same file -> exactly one allowed', async () => {
  const r = repo(), res = await racers(8, r, tmpDir('bajzi-st-'), i => `owner${i}`);
  assert.equal(res.filter(x => x === 'allow').length, 1, res.join());
  assert.equal(locksOf(r).length, 1);
});

test('RACE: a stale lock + 8 concurrent reclaimers -> exactly one allowed', async () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  pre(edit(r, 'x.js', 'old'), env(st));
  age(lockPath(r), fl.TTL_MS + 1000);
  const res = await racers(8, r, st, i => `owner${i}`);
  assert.equal(res.filter(x => x === 'allow').length, 1, res.join());
  assert.equal(locksOf(r).length, 1);
  assert.equal(fs.existsSync(`${lockPath(r)}.reclaim`), false);
});

test('releaseAll frees only own locks, and nothing when BAJZI_LOCK_OWNER differs from session_id', () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  pre(edit(r, 'a.js', 'A'), env(st)); pre(edit(r, 'b.js', 'B'), env(st)); pre(edit(r, 'c.js', 'A'), env(st));
  assert.equal(locksOf(r).length, 3);
  fl.releaseAll({ session_id: 'child', cwd: r }, { BAJZI_LOCK_OWNER: 'A' });
  assert.equal(locksOf(r).length, 3);
  fl.releaseAll({ session_id: 'A', cwd: r }, {});
  assert.equal(locksOf(r).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(r), 'utf8')).owner, 'B');
  fl.releaseAll({ session_id: 'B', cwd: path.join(r, 'nope') }, { BAJZI_LOCK_OWNER: 'B' });   // owner == session_id: frees; cwd below the repo
  assert.equal(locksOf(r).length, 0);
  fl.releaseAll({ session_id: 'B', cwd: tmpDir('bajzi-out-') }, {});   // no repo: no throw
  fl.releaseAll(null, {});
});

test('any internal error fails open', () => {
  assert.equal(fl.check(null), null);
  assert.equal(fl.check({ tool_name: 'Edit', cwd: '/', tool_input: { file_path: 5 }, session_id: 'A' }), null);
  const r = repo();
  fs.mkdirSync(path.join(r, '.git', 'bajzi'), { recursive: true });
  fs.writeFileSync(path.join(r, '.git', 'bajzi', 'file-locks'), 'a file, not a dir');
  assert.equal(fl.check(edit(r, 'x.js', 'A'), {}), null);
});

test('p95 of 20 Edit calls through the wired pre-tool.js < 100 ms, best of 3 batches', PERF, () => {
  const r = repo(), st = tmpDir('bajzi-st-');
  const stdin = JSON.stringify(edit(r, 'x.js', 'A'));
  const batches = [];
  for (let b = 0; b < 3 && !(batches.length && Math.min(...batches) < 100); b++) {
    const ms = [];
    for (let i = 0; i < 20; i++) ms.push(runScript(PRE, stdin, env(st)).ms);
    batches.push(p95(ms));
  }
  assert.ok(Math.min(...batches) < 100, `pre-tool.js Edit p95 per batch ${batches.map(x => x.toFixed(1)).join(' / ')} ms`);
});
