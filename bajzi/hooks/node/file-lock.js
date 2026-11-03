'use strict';
// PreToolUse file lock (pre-tool.js CHECKS row, tools Edit/Write/MultiEdit/NotebookEdit only): one Claude session at a
// time edits a given file of a git repo. The first editor takes <common git dir>/bajzi/file-locks/<key>.json
// (created 'wx', never held open); another session is denied while the holder is live. Sub-agents share the parent's
// session_id; cc-router.js sets BAJZI_LOCK_OWNER for glm/worker headless children so they share their parent's locks.
// Stop/StopFailure/SessionEnd call releaseAll (session-signal.js). No git spawn, no sleep, no wait. Fails open.
// ponytail: the holder refreshes the mtime with a plain utimes, a reclaimer unlinks after its own re-read: an edit that
// lands exactly between that re-read and the unlink loses its refresh (both sessions may then edit). Same for a stale
// `.reclaim` mutex removed by two callers at once. A lock record rewrite under the mutex if it ever matters.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const COVERED = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const RULE = 'file-lock';
const TTL_MS = 10 * 60 * 1000;          // a lock not touched for this long is stale
const MUTEX_MS = 10 * 1000;             // a `.reclaim` mutex older than this is a crashed reclaimer's
const MAX_UP = 60;

// A path written by the other OS, in this OS's form: `/mnt/<d>/x` <-> `<D>:/x` (drive letter case-insensitive).
function toLocal(p, platform = process.platform) {
  const win = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  const wsl = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (platform === 'win32' && wsl) return `${wsl[1].toUpperCase()}:/${wsl[2] || ''}`;
  if (platform !== 'win32' && win) return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  return p;
}

// The gitdir a `.git` file points at, absolute and in this OS's form; null when the file has no `gitdir:` line.
function parseGitFile(text, root, platform = process.platform) {
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  return m ? path.resolve(root, toLocal(m[1], platform)) : null;
}

// {root, common, wt} of the repo owning `target`, or null (no .git up the tree).
function repoOf(target, platform = process.platform) {
  let dir = path.dirname(target);
  for (let i = 0; i < MAX_UP; i++) {
    const g = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { /* none here */ }
    if (st && st.isDirectory()) return { root: dir, common: g, wt: 'main' };
    if (st) {
      const gitdir = parseGitFile(fs.readFileSync(g, 'utf8'), dir, platform);
      if (!gitdir) return null;
      let c = null;
      try { c = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim(); } catch { /* a submodule: no commondir */ }
      if (!c) return { root: dir, common: gitdir, wt: 'main' };
      return { root: dir, common: path.resolve(gitdir, toLocal(c, platform)), wt: gitdir.split(/[\\/]/).filter(Boolean).pop() };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

const lockDir = repo => path.join(repo.common, 'bajzi', 'file-locks');
// The cross-worktree switch (spec §6.21): drop `repo.wt` here to block the same relative path in every worktree.
const keyOf = (repo, rel) => crypto.createHash('sha1').update(`${repo.wt}\0${rel.toLowerCase()}`).digest('hex');
const relOf = (repo, target) => path.relative(repo.root, target).split(path.sep).join('/');

function ident() {
  let ns = '';
  if (process.platform === 'linux') { try { ns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* no procfs */ } }
  return `${os.hostname()}|${process.platform}|${ns}`;
}

function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
}

// LIVE = not (same ident, pid known and gone) and not older than TTL. An unparseable record (rec null) counts by mtime.
function isLive(rec, mtimeMs, now) {
  if (now - mtimeMs >= TTL_MS) return false;
  if (rec && rec.ident === ident() && Number.isInteger(rec.pid) && rec.pid > 0 && pidGone(rec.pid)) return false;
  return true;
}

function inspect(lock) {
  try {
    const mtime = fs.statSync(lock).mtimeMs;
    let rec = null;
    try { const j = JSON.parse(fs.readFileSync(lock, 'utf8')); if (j && typeof j === 'object') rec = j; } catch { /* unparseable */ }
    return { rec, mtime };
  } catch {
    return null;
  }
}

// true = created by us. EEXIST = false. The record is written in the same call; the handle is closed at once.
function create(lock, rec) {
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, JSON.stringify(rec)); } catch (e) { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch { /* gone */ } throw e; }
  fs.closeSync(fd);
  return true;
}

function touch(lock, now) { const d = new Date(now); fs.utimesSync(lock, d, d); }

function ownerOf(input, env) {
  const o = env.BAJZI_LOCK_OWNER || input.session_id;
  return typeof o === 'string' && o ? o : '';
}

function sessionName(owner, env) {
  try {
    const ss = require('./lib/session-status');
    if (!ss.SAFE_ID.test(owner)) return '';
    const j = JSON.parse(fs.readFileSync(path.join(ss.statusDir(env), `${owner}.line.json`), 'utf8'));
    return j && typeof j.session_name === 'string' ? j.session_name : '';
  } catch {
    return '';
  }
}

function denied(rel, lock, held, now, env) {
  const rec = held && held.rec;
  const owner = rec && typeof rec.owner === 'string' ? rec.owner : '?';
  const name = sessionName(owner, env) || owner.slice(0, 8);
  const host = rec && typeof rec.ident === 'string' ? rec.ident.split('|')[0] : '?';
  const cwd = rec && typeof rec.cwd === 'string' ? rec.cwd : '?';
  const min = held ? Math.max(0, Math.floor((now - held.mtime) / 60000)) : 0;
  return {
    kind: 'deny', rule: RULE,
    reason: `${rel} is being edited by another Claude session ${name} (${cwd}, ${host}, last edit ${min} min ago). Wait for its turn to end; if that session is gone, delete ${lock}.`,
  };
}

function retry(rel, lock) {
  return { kind: 'deny', rule: RULE, reason: `${rel} is locked by another Claude session that is being reclaimed; retry in a moment. If it keeps failing, delete ${lock}.` };
}

// Stale lock held by someone else: take it over under the `.reclaim` mutex. null = ours now, else the deny.
function reclaim(lock, rel, rec, now, env) {
  const mx = `${lock}.reclaim`;
  const take = () => { try { fs.mkdirSync(mx); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
  if (!take()) {
    let age = 0;
    try { age = now - fs.statSync(mx).mtimeMs; } catch { /* vanished: treat as fresh, the caller retries */ }
    if (age <= MUTEX_MS) return retry(rel, lock);
    try { fs.rmdirSync(mx); } catch { /* someone else removed it */ }
    if (!take()) return retry(rel, lock);
  }
  try {
    const again = inspect(lock);
    if (again && isLive(again.rec, again.mtime, now)) return denied(rel, lock, again, now, env);
    if (again) { try { fs.unlinkSync(lock); } catch { /* gone already */ } }
  } finally {
    try { fs.rmdirSync(mx); } catch { /* best effort */ }
  }
  if (create(lock, rec)) return null;
  return denied(rel, lock, inspect(lock), now, env);
}

// null (allow) or {kind:'deny', rule:'file-lock', reason}. Any internal error is null (fail open).
function check(input, env = process.env, now = Date.now()) {
  try {
    if (!input || typeof input !== 'object' || !COVERED.test(input.tool_name)) return null;
    const ti = input.tool_input;
    if (!ti || typeof ti !== 'object' || typeof input.cwd !== 'string' || !input.cwd) return null;
    const raw = input.tool_name === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
    if (typeof raw !== 'string' || !raw) return null;
    const owner = ownerOf(input, env);
    if (!owner) return null;
    const target = path.resolve(input.cwd, raw);
    const repo = repoOf(target);
    if (!repo) return null;
    const rel = relOf(repo, target);
    if (!rel || rel === '..' || rel.startsWith('../') || /^\.git(?:\/|$)/i.test(rel)) return null;
    const dir = lockDir(repo);
    const lock = path.join(dir, `${keyOf(repo, rel)}.json`);
    fs.mkdirSync(dir, { recursive: true });
    const pid = parseInt(env.CLAUDE_PID, 10);
    const rec = { owner, pid: pid > 0 ? pid : null, ident: ident(), cwd: input.cwd, file: rel, created: new Date(now).toISOString() };
    if (create(lock, rec)) return null;
    const held = inspect(lock);
    if (!held) return create(lock, rec) ? null : retry(rel, lock);   // released between our two calls
    if (held.rec && held.rec.owner === owner) { touch(lock, now); return null; }
    if (isLive(held.rec, held.mtime, now)) return denied(rel, lock, held, now, env);
    return reclaim(lock, rel, rec, now, env);
  } catch {
    return null;
  }
}

// Stop/StopFailure/SessionEnd: unlink every lock of this session's owner in the repo of input.cwd. A headless child
// (BAJZI_LOCK_OWNER set and different from its own session_id) releases nothing. Never throws.
function releaseAll(input, env = process.env) {
  try {
    if (!input || typeof input.cwd !== 'string' || !input.cwd) return;
    if (env.BAJZI_LOCK_OWNER && env.BAJZI_LOCK_OWNER !== input.session_id) return;
    const owner = ownerOf(input, env);
    const repo = owner && repoOf(path.join(path.resolve(input.cwd), 'x'));
    if (!repo) return;
    const dir = lockDir(repo);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && j.owner === owner) fs.unlinkSync(path.join(dir, f));
      } catch { /* unreadable or gone: leave it */ }
    }
  } catch { /* release never changes the caller */ }
}

module.exports = { check, releaseAll, toLocal, parseGitFile, TTL_MS };
