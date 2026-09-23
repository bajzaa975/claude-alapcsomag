'use strict';
// Context guard. One script, behaviour by hook_event_name:
//   PostToolUse, used >= 40%: additionalContext warning, at most once per 5 tool calls.
//   PreToolUse,  used >= 50%: deny EVERY tool call (Agent/Task included) except the handoff itself:
//     - the Skill tool invoking bajzi:handoff;
//     - Write/Edit/MultiEdit/Read on runtime/handoff/** or runtime/HANDOFF.md (relative or absolute);
//     - Bash/PowerShell, ONE command with no shell metacharacters (no chaining, pipes, redirects
//       except a trailing 2>/dev/null, substitution): git status|diff|log|rev-parse|check-ignore,
//       git symbolic-ref [--quiet] [--short] HEAD, mkdir [-p] runtime/handoff,
//       [git] mv runtime/HANDOFF.md|runtime/handoff/<f> runtime/handoff/<f>.
//   The deny reason names the handoff file for this branch: runtime/handoff/<slug>.md.
// used = the bridge the status line writes; missing / unparseable / older than 60 s = unknown
// = allow. Fails open on any internal error.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { readInput, deny, addContext, runHook } = require('./lib/hook-io');
const { readBridge, warnPath } = require('./lib/bridge');

const WARN_AT = 40;
const BLOCK_AT = 50;
const WARN_EVERY = 5;
const HANDOFF_DIR = /(^|\/)runtime\/handoff\/[^/]/i;
const HANDOFF_FILE = /(^|\/)runtime\/handoff\.md$/i;
const HANDOFF_DIR_ONLY = /^(?:\.\/)?runtime\/handoff\/?$/i;
const SHELL_META = /[;&|<>`$()\r\n]/;
const DEVNULL_TAIL = /\s+2>(?:\/dev\/null|nul)$/i;
const GIT_BIN = /^(?:\/usr\/bin\/)?git(?:\.exe)?$/i;
const GIT_READ_ANY_ARGS = new Set(['status', 'diff', 'log', 'rev-parse', 'check-ignore']);
const HANDOFF_SKILLS = new Set(['bajzi:handoff', 'handoff']);

function norm(p) {
  return p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
}

function isHandoffPath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const n = norm(p);
  if (n.split('/').some(seg => seg === '..')) return false;
  return HANDOFF_DIR.test(n) || HANDOFF_FILE.test(n);
}

// A file INSIDE runtime/handoff/ (never runtime/HANDOFF.md, never the directory itself), with no
// '.' or empty segment below runtime/handoff/.
function isHandoffDirFile(p) {
  if (!isHandoffPath(p)) return false;
  const n = norm(p);
  const m = HANDOFF_DIR.exec(n);
  return !!m && n.slice(m.index + m[0].length - 1).split('/').every(seg => seg !== '' && seg !== '.');
}

// Whitespace split that keeps "..." / '...' tokens whole (quotes dropped). Only ever called on a
// command already free of shell metacharacters.
function tokens(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

// Repo-relative runtime/... only: an absolute path names SOME runtime/handoff, not this repo's.
const REPO_REL = /^(?:\.\/)?runtime\//i;
// Every whitespace-separated word of a mkdir / mv / git mv: plain path characters, optionally
// wrapped whole in one pair of quotes. Anything else (embedded quotes, \ escapes under Bash, {} brace
// expansion, ?*[] globs, ~, drive colons) lets the shell produce a path norm() never sees.
const PLAIN_WORD = { Bash: /^(["']?)[A-Za-z0-9._/-]+\1$/, PowerShell: /^(["']?)[A-Za-z0-9._/\\-]+\1$/ };

function mvRule(args) {
  if (args.length !== 2 || args.some(a => a.startsWith('-'))) return null;
  if (args.some(a => norm(a).startsWith('/'))) return { refused: 'path-scope' };
  const [src, dst] = args;
  if (!REPO_REL.test(norm(src)) || !REPO_REL.test(norm(dst))) return null;
  const srcOk = HANDOFF_FILE.test(norm(src)) ? isHandoffPath(src) : isHandoffDirFile(src);
  return srcOk && isHandoffDirFile(dst) ? 'ctx-allow-handoff-mv' : null;
}

// {rule} when the command is an allowed handoff snippet, else {refused}: 'shell-meta',
// 'path-chars' (a mkdir/mv word outside PLAIN_WORD), 'path-scope' (absolute path or git -C on a
// mkdir/mv) or 'not-allowlisted'.
function commandCheck(command, tool) {
  let cmd = typeof command === 'string' ? command.trim() : '';
  cmd = cmd.replace(DEVNULL_TAIL, '');
  if (!cmd || SHELL_META.test(cmd)) return { refused: 'shell-meta' };
  const t = tokens(cmd);
  const mutating = t[0] === 'mkdir' || t[0] === 'mv' || (GIT_BIN.test(t[0] || '') && t.includes('mv'));
  if (mutating && !cmd.split(/\s+/).every(w => PLAIN_WORD[tool].test(w))) return { refused: 'path-chars' };
  const r = commandRule(t);
  return typeof r === 'string' ? { rule: r } : { refused: r ? r.refused : 'not-allowlisted' };
}

function commandRule(t) {
  if (t[0] === 'mkdir') {
    const rest = t.slice(1).filter(a => a !== '-p');
    if (rest.some(a => norm(a).startsWith('/'))) return { refused: 'path-scope' };
    return rest.length === 1 && t.length - 1 <= 2 && HANDOFF_DIR_ONLY.test(norm(rest[0])) ? 'ctx-allow-handoff-mkdir' : null;
  }
  if (t[0] === 'mv') return mvRule(t.slice(1));
  if (!GIT_BIN.test(t[0] || '')) return null;
  let i = 1;
  let otherDir = false;
  // Global options: only -C <dir> and two harmless flags. Never -c (core.fsmonitor/pager run commands).
  while (i < t.length && t[i].startsWith('-')) {
    if (t[i] === '-C' && i + 1 < t.length) { otherDir = true; i += 2; }
    else if (t[i] === '--no-pager' || t[i] === '--no-optional-locks') i += 1;
    else return null;
  }
  const sub = t[i];
  const args = t.slice(i + 1);
  if (GIT_READ_ANY_ARGS.has(sub)) {
    return args.some(a => /^--output(?:=|$)/.test(a) || a === '--ext-diff') ? null : 'ctx-allow-git-read';
  }
  if (sub === 'symbolic-ref') {
    const refs = args.filter(a => !['--quiet', '-q', '--short'].includes(a));
    return refs.length === 1 && refs[0] === 'HEAD' ? 'ctx-allow-git-read' : null;
  }
  if (sub === 'mv') return otherDir ? { refused: 'path-scope' } : mvRule(args);
  return null;
}

function skillRule(tool, ti) {
  if (tool === 'Skill') {
    for (const k of ['skill', 'name', 'command']) {
      const v = typeof ti[k] === 'string' ? ti[k].trim().replace(/^\//, '') : '';
      if (v && HANDOFF_SKILLS.has(v)) return 'ctx-allow-handoff-skill';
    }
    return null;
  }
  if (tool === 'SlashCommand') {
    const v = typeof ti.command === 'string' ? ti.command.trim() : '';
    return /^\/(?:bajzi:)?handoff(?:\s|$)/.test(v) ? 'ctx-allow-handoff-skill' : null;
  }
  return null;
}

// The rule id that exempts this call from the 50% block, or null.
function exemptCheck(input) {
  const tool = input && input.tool_name;
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'Read') {
    return { rule: isHandoffPath(ti.file_path) ? 'ctx-allow-handoff-file' : null };
  }
  if (tool === 'Bash' || tool === 'PowerShell') return commandCheck(ti.command, tool);
  return { rule: skillRule(tool, ti) };
}

function exemptRule(input) {
  return exemptCheck(input).rule || null;
}

function exempt(input) {
  return exemptRule(input) !== null;
}

// Same derivation as skills/handoff/SKILL.md and hooks/handoff-load.sh.
function slugify(branch) {
  if (typeof branch !== 'string' || !branch) return 'default';
  const s = branch.replace(/[A-Z]/g, c => c.toLowerCase())
    .replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '')
    .slice(0, 60).replace(/-+$/, '');
  return s || 'default';
}

// = `git symbolic-ref --quiet --short HEAD`, without spawning git (a spawn alone costs ~40 ms on
// Windows and this runs on every denied call): walk up to .git (a dir, or a worktree/submodule
// `gitdir:` file), read HEAD, take refs/heads/<branch>. Detached / no repo / unreadable = ''.
// Honours GIT_CEILING_DIRECTORIES like git does (never steps up INTO a ceiling dir).
function currentBranch(cwd, env = process.env) {
  try {
    const win = process.platform === 'win32';
    const key = p => (win ? p.toLowerCase() : p);
    const ceilings = new Set(String(env.GIT_CEILING_DIRECTORIES || '').split(path.delimiter)
      .filter(Boolean).map(p => key(path.resolve(p))));
    let dir = path.resolve(cwd);
    for (let depth = 0; depth < 256; depth++) {
      const dotgit = path.join(dir, '.git');
      let st = null;
      try { st = fs.statSync(dotgit); } catch { st = null; }
      if (st) {
        let gitDir = dotgit;
        if (st.isFile()) {
          const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
          if (!m) return '';
          gitDir = path.resolve(dir, m[1]);
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
        const r = /^ref:[ \t]*refs\/heads\/(.+?)\s*$/.exec(head);
        return r ? r[1] : '';
      }
      const up = path.dirname(dir);
      if (up === dir || ceilings.has(key(up))) return '';
      dir = up;
    }
  } catch {
    // unreadable HEAD or .git file: same as git failing -> default slug
  }
  return '';
}

function handoffFile(input) {
  const cwd = input && typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return `runtime/handoff/${slugify(currentBranch(cwd))}.md`;
}

function shouldWarn(sessionId, dir) {
  const p = warnPath(sessionId, dir);
  if (!p) return false;
  let calls = null;
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s && Number.isInteger(s.calls) && s.calls >= 0) calls = s.calls;
  } catch {
    calls = null;
  }
  const warn = calls === null || calls + 1 >= WARN_EVERY;
  const next = warn ? 0 : calls + 1;
  // Random tmp name opened with 'wx' (as in bridge.js): never follows a pre-planted file or symlink.
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ calls: next }), { flag: 'wx' });
    created = true;
    fs.renameSync(tmp, p);
  } catch {
    if (created) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ } }
  }
  return warn;
}

function decide(input, { nowMs = Date.now(), dir } = {}) {
  if (!input || typeof input !== 'object') return { kind: 'allow' };
  const used = readBridge(input.session_id, nowMs, 60, dir);
  if (used === null) return { kind: 'allow' };
  const ev = input.hook_event_name;
  if (ev === 'PreToolUse') {
    if (used < BLOCK_AT) return { kind: 'allow' };
    const { rule, refused } = exemptCheck(input);
    if (rule) return { kind: 'allow', rule };
    const file = handoffFile(input);
    const why = refused === 'shell-meta' ? ' This command was refused for a shell metacharacter (; & | < > ` $ ( ) or a line break).'
      : refused === 'path-chars' ? ' This command was refused: mkdir/mv arguments may only hold letters, digits and . _ / - (Bash: forward slashes only; no quotes inside a word, braces, globs, ~ or drive letters).'
      : refused === 'path-scope' ? ' This command was refused: mkdir/mv paths must be relative to the repo root (runtime/...), with no git -C.' : '';
    return {
      kind: 'deny',
      rule: 'ctx-block-50',
      ...(refused ? { refused } : {}),
      reason: `Context is at ${used}% (block threshold ${BLOCK_AT}%). Start no new work: write the handoff now with /bajzi:handoff, directly to ${file}, then tell the user to run /clear. Still allowed: the bajzi:handoff skill; Write/Edit/Read on runtime/handoff/** and runtime/HANDOFF.md; single commands with no chaining, pipes or substitution: git status|diff|log|rev-parse|check-ignore, git symbolic-ref --short HEAD, mkdir -p runtime/handoff, git mv runtime/HANDOFF.md ${file}.${why}`,
    };
  }
  if (ev === 'PostToolUse') {
    if (used < WARN_AT || !shouldWarn(input.session_id, dir)) return { kind: 'allow' };
    return {
      kind: 'context',
      text: `[bajzi:ctx-warn-40] Context is at ${used}% (warn ${WARN_AT}%, hard block at ${BLOCK_AT}%). Finish the current slice, take on no new scope, and write the handoff (/bajzi:handoff) before ${BLOCK_AT}%.`,
    };
  }
  return { kind: 'allow' };
}

function main() {
  runHook('context-guard', () => {
    const d = decide(readInput());
    if (d.kind === 'deny') deny(d.reason, d.rule);
    else if (d.kind === 'context') addContext('PostToolUse', d.text);
  });
}

if (require.main === module) main();

module.exports = {
  decide, exempt, exemptRule, isHandoffPath, slugify, handoffFile, WARN_AT, BLOCK_AT, WARN_EVERY,
};
