'use strict';
// Data sources for the status line. Everything is cheap or cached; nothing ever waits on the
// network or on `worker --usage` (that runs in a DETACHED child: node status-parts.js --refresh-glm).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execSync, spawn } = require('node:child_process');

const GIT_TTL_MS = 5000;
const GLM_TTL_MS = 5 * 60 * 1000;
const GLM_LOCK_MS = 60 * 1000;
const LOCK_FUTURE_MS = 5000;     // clock/mtime skew: a lock this far in the future still counts as held

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Random tmp name opened with 'wx' (as in bridge.js): a pre-planted file or symlink at the tmp
// path in the shared tmpdir is never followed; the write just fails open.
function writeJsonAtomic(p, obj) {
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), { flag: 'wx' });
    created = true;
    fs.renameSync(tmp, p);
    return true;
  } catch {
    if (created) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ } }
    return false;
  }
}

function readHead(p, n) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(n);
    const k = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, k).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// C0/C1 controls incl. ESC and DEL: a branch name reaches the terminal verbatim in the status line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function cleanBranch(b) {
  return String(b).replace(CONTROL, '').trim();
}

// Schema of a cached git-info entry: null (not a repo) or {branch: clean non-empty string, dirty: bool}.
function validGitInfo(info) {
  if (info === null) return true;
  return !!info && typeof info === 'object' && !Array.isArray(info)
    && typeof info.branch === 'string' && info.branch.length > 0 && info.branch.length <= 256
    && info.branch === cleanBranch(info.branch) && typeof info.dirty === 'boolean';
}

function parseGitStatus(out) {
  let branch = null;
  let oid = null;
  let dirty = false;
  for (const line of String(out).split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line && !line.startsWith('#')) dirty = true;
  }
  if (branch === '(detached)') branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached';
  branch = branch === null ? '' : cleanBranch(branch).slice(0, 256);
  return branch ? { branch, dirty } : null;
}

function gitCachePath(cwd) {
  const key = crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `bajzi-git-${key}.json`);
}

function gitInfo(cwd, nowMs = Date.now()) {
  const cache = gitCachePath(cwd);
  const c = readJson(cache);
  // The cache lives in the shared tmpdir: anything that fails the schema is ignored and recomputed.
  if (c && typeof c === 'object' && typeof c.ts === 'number' && nowMs - c.ts >= 0 && nowMs - c.ts < GIT_TTL_MS
    && 'info' in c && validGitInfo(c.info)) return c.info;
  let info = null;
  try {
    // --no-optional-locks: a status line must never take index.lock from under a real git command.
    const out = execFileSync('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true });
    info = parseGitStatus(out);
  } catch {
    info = null;
  }
  writeJsonAtomic(cache, { ts: nowMs, info });
  return info;
}

function handoffTask(cwd) {
  const dir = path.join(cwd, 'runtime', 'handoff');
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.md')) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile() && (!best || st.mtimeMs > best.m)) best = { n, m: st.mtimeMs };
    } catch { /* vanished between readdir and stat */ }
  }
  if (!best) return null;
  let head;
  try { head = readHead(path.join(dir, best.n), 4096); } catch { return null; }
  const m = /Task:[ \t]*([^\r\n]*)/.exec(head);
  const t = m ? m[1].trim() : '';
  if (!t) return null;
  return t.length > 20 ? t.slice(0, 19) + '\u2026' : t;
}

function openQueueCount(cwd) {
  const dir = path.join(cwd, 'runtime', 'review-queue');
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    try {
      if (/^status:[ \t]*(open|pending)[ \t]*$/mi.test(readHead(path.join(dir, f), 1024))) n++;
    } catch { /* unreadable item: not counted */ }
  }
  return n;
}

function glmCachePath(home) {
  return path.join(home, '.claude', 'bajzi', 'glm-share.json');
}

function spawnRefresh(cachePath, env) {
  const child = spawn(process.execPath, [__filename, '--refresh-glm', cachePath],
    { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
}

// Lock age: the timestamp inside it; a lock whose content is not (yet) a timestamp -- a concurrent
// writer between create and write -- is aged by its mtime instead.
function lockAgeMs(lock, nowMs) {
  let raw = '';
  let st;
  try { raw = fs.readFileSync(lock, 'utf8'); st = fs.statSync(lock); } catch { return null; }
  const at = Number(raw);
  if (raw.trim() && Number.isFinite(at) && at > 0) return nowMs - at;
  return Date.now() - st.mtimeMs;
}

// O_CREAT|O_EXCL ('wx'): of any number of concurrent status lines exactly one creates the lock and
// starts the refresh. An expired lock (>= GLM_LOCK_MS old, or > LOCK_FUTURE_MS in the future) is removed and retried once.
function takeLock(lock, nowMs) {
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch { /* the create below fails */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(nowMs), { flag: 'wx' });
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST' || attempt > 0) return false;
      const age = lockAgeMs(lock, nowMs);
      if (age !== null && age > -LOCK_FUTURE_MS && age < GLM_LOCK_MS) return false;
      try { fs.unlinkSync(lock); } catch { /* someone else took it over first */ }
    }
  }
  return false;
}

function glmShare({ nowMs = Date.now(), home = os.homedir(), env = process.env, refresh = spawnRefresh } = {}) {
  const cachePath = glmCachePath(home);
  const c = readJson(cachePath);
  const fresh = c && typeof c.ts === 'number' && nowMs - c.ts >= 0 && nowMs - c.ts < GLM_TTL_MS;
  if (!fresh && takeLock(cachePath + '.lock', nowMs)) {
    try { refresh(cachePath, env); } catch { /* no refresh this render; the next one retries after the lock expires */ }
  }
  return c && typeof c.pct === 'number' && Number.isFinite(c.pct) ? c.pct : null;
}

function refreshGlm(cachePath, env = process.env) {
  const cmd = (env.BAJZI_WORKER_CMD || 'worker') + ' --usage 24h --json';
  let pct = null;
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, windowsHide: true, env });
    const j = JSON.parse(out);
    if (typeof j.glm_share_pct === 'number' && Number.isFinite(j.glm_share_pct)) pct = Math.round(j.glm_share_pct);
  } catch {
    pct = null;
  }
  if (pct === null) {
    const prev = readJson(cachePath);
    // Keep the last good value: leave the cache as it is and keep the lock, so the next attempt
    // waits for the lock to expire (GLM_LOCK_MS) instead of re-running a failing worker per render.
    if (prev && typeof prev.pct === 'number' && Number.isFinite(prev.pct)) return;
  }
  try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); } catch { /* write below fails quietly */ }
  writeJsonAtomic(cachePath, { ts: Date.now(), pct });
  try { fs.unlinkSync(cachePath + '.lock'); } catch { /* already gone */ }
}

if (require.main === module && process.argv[2] === '--refresh-glm' && process.argv[3]) {
  try { refreshGlm(process.argv[3]); } catch { /* detached child: nobody to report to */ }
}

module.exports = { gitInfo, gitCachePath, validGitInfo, parseGitStatus, handoffTask, openQueueCount, glmShare, refreshGlm, glmCachePath };
