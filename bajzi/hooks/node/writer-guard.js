'use strict';
// PreToolUse writer guard for Edit, Write, MultiEdit and NotebookEdit (owner rule 2026-10-02): a
// bajzi plugin change is made only by the session started in the bajzi repo's main checkout.
// Installed copies (plugin cache, marketplace clone) are denied to every session; a bajzi repo
// tree is open only to that owner session, except main(R)/runtime/requests/ (the inbox, open to
// all). `node writer-guard.js notice` is the SessionStart inbox count. Fs only; fails open.
// ponytail: Bash/PowerShell writes (sed -i, a git commit made by a foreign session) are not
// blocked; the global "bajzi plugin changes" rule text covers intent. A Bash parser if it matters.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInput, deny, runHook, writeAll } = require('./lib/hook-io');

const COVERED = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const RULE = 'bajzi-writer';
const MAX_UP = 40;
const INSTALLED_REASON = "Installed bajzi copies change only through a release and `claude plugin update`. Send the request to the session started in the bajzi repo main checkout (see 'bajzi plugin changes' in ~/.claude/CLAUDE.md).";

// Comparison key: forward slashes, no trailing slash, lower-case on win32. Never shown to the user.
function key(p, platform) {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

function under(p, dir, platform) {
  return key(p, platform).startsWith(`${key(dir, platform)}/`);
}

function isBajziRoot(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
    return !!m && m.name === 'bajzi-plugins';
  } catch {
    return false;   // missing, unreadable or not JSON: not a bajzi root, keep walking
  }
}

// The nearest ancestor of `dir` (itself included) that is a bajzi repo tree, or null.
function findTree(dir) {
  for (let i = 0; i < MAX_UP; i++) {
    if (isBajziRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// main(R) and whether R is itself a main checkout. A `.git` file `gitdir: <main>/.git/worktrees/<n>`
// is a linked worktree of <main>; anything else that is not a `.git` dir counts as main(R) = R.
function mainOf(r) {
  const g = path.join(r, '.git');
  let st;
  try { st = fs.statSync(g); } catch { return { main: r, isMain: false }; }
  if (st.isDirectory()) return { main: r, isMain: true };
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(g, 'utf8'));
  const wt = m && /^(.+)\/\.git\/worktrees\/[^/]+$/.exec(path.resolve(r, m[1]).replace(/\\/g, '/'));
  return { main: wt ? path.resolve(wt[1]) : r, isMain: false };
}

function denied(reason) {
  return { kind: 'deny', rule: RULE, reason };
}

// The whole check, as main() and pre-tool.js run it: null or {kind:'deny', rule, reason}. Any
// internal error is null (fail open).
function check(input, { home = os.homedir(), platform = process.platform } = {}) {
  try {
    if (!input || typeof input !== 'object' || !COVERED.test(input.tool_name)) return null;
    const ti = input.tool_input;
    const cwd = input.cwd;
    if (!ti || typeof ti !== 'object' || typeof cwd !== 'string' || !cwd) return null;
    const raw = input.tool_name === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
    if (typeof raw !== 'string' || !raw) return null;
    const target = path.resolve(cwd, raw);
    for (const kind of ['cache', 'marketplaces']) {
      if (under(target, path.join(home, '.claude', 'plugins', kind, 'bajzi-plugins'), platform)) return denied(INSTALLED_REASON);
    }
    const r = findTree(path.dirname(target));
    if (!r) return null;
    const { main } = mainOf(r);
    const r0 = findTree(path.resolve(cwd));
    if (r0 && mainOf(r0).isMain && key(r0, platform) === key(main, platform)) return null;
    const inbox = path.join(main, 'runtime', 'requests');
    if (under(target, inbox, platform)) return null;
    return denied(`bajzi plugin changes are made only by a session started in ${main} (the bajzi repo main checkout). Send the request with SendMessage to that session, or write it to ${path.join(inbox, '<YYYY-MM-DD>-<topic>.md')}.`);
  } catch {
    return null;
  }
}

// SessionStart: {systemMessage} when `cwd` is inside a bajzi main checkout whose
// runtime/requests/ holds top-level *.md files, else null. Only reads dirs; may throw (the CLI
// runs it inside runHook).
function notice(cwd) {
  const r0 = findTree(path.resolve(cwd));
  if (!r0 || !mainOf(r0).isMain) return null;
  let n = 0;
  try {
    n = fs.readdirSync(path.join(r0, 'runtime', 'requests'), { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name)).length;
  } catch {
    return null;
  }
  return n ? { systemMessage: `bajzi: ${n} pending plugin change request(s) in runtime/requests/ - handle each, then move it to runtime/requests/done/` } : null;
}

function main() {
  if (process.argv[2] === 'notice') {
    runHook('writer-guard-notice', () => {
      const i = readInput();
      const msg = notice(i && typeof i.cwd === 'string' && i.cwd ? i.cwd : process.cwd());
      if (msg) writeAll(JSON.stringify(msg));
    });
    return;
  }
  runHook('writer-guard', () => {
    const d = check(readInput());
    if (d) deny(d.reason, d.rule);
  });
}

if (require.main === module) main();

module.exports = { check, notice };
