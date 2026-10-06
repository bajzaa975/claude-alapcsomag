'use strict';
// PreToolUse saver guard (owner decision 2026-10-06): a session at L2/L3 that still runs on Claude
// (started with plain `claude`, not `worker`) may not write code itself; writing is GLM's job
// (`glm -p`). Active only with the saver gate open (CC_WORKER_MODE set, or day-run on: the same
// rule as lib-saver-level.sh:saver_resolve), level >= 2 and an Anthropic provider. Edit/Write
// outside runtime/, ~/.claude/ and tmpdir, a writing sub-agent, and an obvious Bash/PowerShell file
// write are denied (the last not with BAJZI_SANDBOX=1: a Linux `split` session, where the OS sandbox
// judges shell writes); `worker --level/--set` is denied always (the owner uses `! worker --level N`).
// Inside the Z.ai peak window the write denies become counted allows. Every deny and every peak
// allow appends a line to <project>/runtime/routing-violations.log (project = CLAUDE_PROJECT_DIR, else cwd). Stdlib only; fails open.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInput, deny, runHook } = require('./lib/hook-io');
const { resolveLevel, hostOf } = require('./lib/saver-level');
const { peakStatus } = require('./lib/peak');

const RULE = 'saver-guard';
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const RISK_AGENT = /(^|:)implementer-risk$/i;
const BUILTIN_AGENTS = new Set(['Explore', 'Plan', 'claude-code-guide']);   // case-sensitive
const BAJZI_AGENTS = new Set(['bajzi:reviewer', 'bajzi:implementer-risk']);   // case-insensitive
const WS = /[ \t\n\v\f\r]/g;
const WORKER_LEVEL = /(?:^|[\s;&|(`'"/\\])(?:worker(?:\.cmd)?|cc-router(?:\.js)?)(?=[\s;&|)`'"]|$)[^;&|\n]*?(?<![\w-])(?:--?)?(?:level|set)(?![-\w])/i;
const SEP = String.raw`(?:^|[\s;&|(])`;   // a command word starts the text or follows a space/separator
// a shell/eval wrapper whose quoted argument is then run as a command
const WRAP_ARG = new RegExp(String.raw`${SEP}(?:eval|(?:ba|z|da|k)?sh|pwsh|powershell|cmd)(?:\.exe)?(?:\s+[-/]\w+)*\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`, 'gi');
const INPLACE = new RegExp(String.raw`${SEP}(sed|perl)(?=\s)([^;&|\n]*)`, 'g');
const SED_I = /^(?:-[a-zA-Z]*i|--in-place)/;
const PERL_I = /^-[0-9lanpsStTuUwWXcCfF]*i/;   // flags without an argument, then i: -Mstrict is not -i
const SED_SCRIPT_OPT = /^(?:-[a-zA-Z]*e|--expression|-f|--file)$/;
const PERL_SCRIPT_OPT = /^-[a-zA-Z]*[eE]$/;
const REDIRECT = /(?<![-=])>>?\|?[ \t]*(&[\d-]|[^\s;&|<>()]+)?/g;
const TEE = /(?:^|[;&|(])\s*tee((?:[ \t]+[^\s;&|<>()]+)*)/g;
const PS_WRITE = new RegExp(String.raw`${SEP}(Set-Content|Add-Content|Out-File|New-Item)(?=\s|$)([^;|\n]*)`, 'gi');
const PS_PATH_OPT = /^-(?:Path|LiteralPath|FilePath)$/i;
const HEREDOC = /(?<!<)<<-?(?!<)[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;   // terminated only: an unterminated <<WORD strips nothing
const SINKS =/^(?:\/dev\/null|&[\d-]|\$null)$/i;

const blockedReason = n => `saver-guard: this session is at L${n} but runs on Claude (started with plain claude). Writing code is GLM's job here: run it as glm -p with the brief on stdin (Bash run_in_background), or relaunch the session with worker. Risk slices: bajzi:implementer-risk. Owner override: type ! worker --level 0 in the prompt.`;
const PROTECTED_REASON = 'saver-guard: this file controls the saver guard or the saver level; only the owner may change it (type it as a ! command in the prompt, which bypasses hooks).';
const SPLIT_REASON = 'saver-guard: in a split session write scratch files with the shell; the Edit tools write only <project>/runtime/ and ~/.claude/projects/*/memory/ outside the project, and never <project>/.git or <project>/.githooks; any other file (hooks, git config, settings) is changed by the owner only (type it as a ! command in the prompt).';
const HOME_VAR = /^(?:~|\$\{HOME\}|\$HOME|\$env:(?:HOME|USERPROFILE))(?=$|[/\\])/i;
const TMP_VAR = /^(?:\$\{(?:TMPDIR|TEMP|TMP)\}|\$(?:TMPDIR|TEMP|TMP)|\$env:(?:TMPDIR|TEMP|TMP))(?=$|[/\\])/i;
const UNRESOLVED_REASON = 'saver-guard: cannot resolve the real path of this file (dangling or looping symlink, or no access); refusing the write.';
const LEVEL_REASON = 'saver-guard: only the owner may change the saver level. Ask the owner to type ! worker --level <n> in the prompt (it bypasses hooks).';

// The real path of `a`, resolved the OS way: the components of the RAW path left to right, so a link is
// followed before a later `..` (`<tmp>/lh/../x` with lh -> <home>/.config is <home>/x, never <tmp>/x). The
// part that does not exist yet stays as a tail (a `..` there collapses). A dangling or looping symlink or
// any other realpath error throws.
const SEG = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
function realPath(a) {
  if (!path.isAbsolute(a)) a = path.resolve(a);
  const root = path.parse(a).root;
  let cur = fs.realpathSync(root);
  const tail = [];
  for (const seg of a.slice(root.length).split(SEG)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (tail.length) tail.pop(); else cur = path.dirname(cur);
    } else if (tail.length) {
      tail.push(seg);
    } else {
      const next = path.join(cur, seg);
      try {
        cur = fs.realpathSync(next);
      } catch (e) {
        if (e.code !== 'ENOENT' || fs.lstatSync(next, { throwIfNoEntry: false })) throw e;
        tail.push(seg);
      }
    }
  }
  return path.join(cur, ...tail);
}
// Path key as writer-guard.js: `/` separators, no trailing slash, lower-case on win32.
const norm = r => {
  const s = r.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
// The key of the real path, so a symlink cannot hide its target and a symlinked allowed dir still matches (an unresolvable path keeps its lexical form).
function key(p) {
  let r = path.resolve(p);
  try { r = realPath(p); } catch { /* keep the lexical path */ }
  return norm(r);
}
// The key of the literal path: normalised (`..` collapsed), no link followed.
const lex = p => norm(path.resolve(p));
function under(p, dir) {
  return key(p).startsWith(`${key(dir)}/`);
}

// The day-run mode file read of lib-saver-level.sh: the first existing of <project>/runtime/bajzi-mode,
// <home>/.claude/bajzi-mode alone decides; head -1, every whitespace removed, ASCII lower-case.
function dayRunOn(proj, home) {
  for (const f of [path.join(proj, 'runtime', 'bajzi-mode'), path.join(home, '.claude', 'bajzi-mode')]) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    try {
      const line = fs.readFileSync(f, 'latin1').split('\n')[0];
      return line.replace(WS, '').replace(/[A-Z]/g, c => c.toLowerCase()) === 'day-run';
    } catch {
      return false;
    }
  }
  return false;
}

// A heredoc body is data (a glm brief, a commit message), not shell: keep only its header line,
// which still carries the command's own redirect (`cat <<EOF > src/x.js`).
const stripHeredoc = cmd => cmd.replace(HEREDOC, m => m.split('\n')[0]);
// Quoted text goes inert: its metacharacters go, its whitespace becomes `_` (so `-m "a -> b"`
// holds no redirect, while a quoted redirect target still resolves to a path).
const inert = cmd => cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => q.slice(1, -1).replace(/[<>|;&]/g, '').replace(/\s/g, '_'));

// ponytail: a token heuristic over the command text, not a sandbox. A creative write (python -c,
// cp, git apply, an unknown cmdlet alias) still passes. A real shell parser if Claude starts routing
// around it. Returns 0 (no write), 1 (a write outside the allowed dirs) or 2 (a protected file).
function shellWrites(cmd, allowed, protectedPath) {
  const s = inert(stripHeredoc(cmd));
  let hit = 0;
  const target = t => {
    if (SINKS.test(t)) return;
    if (protectedPath(t)) hit = 2;
    else if (hit < 1 && !allowed(t)) hit = 1;
  };
  for (const m of s.matchAll(INPLACE)) {
    const sed = m[1] === 'sed';
    const args = m[2].split(/\s+/).filter(Boolean);
    if (!args.some(a => (sed ? SED_I : PERL_I).test(a))) continue;
    const files = [];
    let script = false;   // sed/perl take the script from the first operand unless -e/-f gave it
    for (let i = 0; i < args.length; i++) {
      if ((sed ? SED_SCRIPT_OPT : PERL_SCRIPT_OPT).test(args[i])) { script = true; i++; continue; }
      if (!args[i].startsWith('-')) files.push(args[i]);
    }
    if (!script) files.shift();
    if (!files.length) hit = Math.max(hit, 1);   // stdin or unclear: deny
    files.forEach(target);
  }
  for (const m of s.matchAll(REDIRECT)) if (m[1]) target(m[1]);
  for (const m of s.matchAll(TEE)) m[1].trim().split(/\s+/).forEach(t => { if (t && !t.startsWith('-')) target(t); });
  for (const m of s.matchAll(PS_WRITE)) {
    const args = m[2].trim().split(/\s+/).filter(Boolean);
    if (/^New-Item$/i.test(m[1]) && /(?:^|\s)-(?:ItemType|Type)\s+Directory(?:\s|$)/i.test(m[2])) continue;
    const named = args.findIndex(a => PS_PATH_OPT.test(a));
    const t = named >= 0 ? args[named + 1] : args[0];
    if (!t || t.startsWith('-')) hit = Math.max(hit, 1);   // no clear target: deny
    else target(t);
  }
  return hit;
}

function logLine(proj, now, word, cause, tool) {
  try {
    const dir = path.join(proj, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    fs.appendFileSync(path.join(dir, 'routing-violations.log'), `${ts}\tlevel=${word}\tcause=${cause}\ttool=${tool}\n`);
  } catch {
    // fail open: the log is a counter, never a reason to change the decision
  }
}

// null (allow) or {kind:'deny', rule, reason}. Any internal error is null (fail open).
function check(input, { env = process.env, home = os.homedir(), now = new Date(), tmpdir = os.tmpdir() } = {}) {
  try {
    if (!input || typeof input !== 'object') return null;
    const tool = input.tool_name;
    const ti = input.tool_input;
    const cwd = input.cwd;
    if (typeof tool !== 'string' || !ti || typeof ti !== 'object' || typeof cwd !== 'string' || !cwd) return null;
    const isEdit = EDIT_TOOLS.test(tool);
    const isAgent = tool === 'Agent' || tool === 'Task';
    const isShell = tool === 'Bash' || tool === 'PowerShell';
    if (!isEdit && !isAgent && !isShell) return null;

    const host = hostOf(env.ANTHROPIC_BASE_URL);
    if (host !== null && host !== 'anthropic.com' && !host.endsWith('.anthropic.com')) return null;
    const proj = String(env.CLAUDE_PROJECT_DIR || '') || cwd;
    const gate = String(env.CC_WORKER_MODE || '').replace(WS, '') !== '' || dayRunOn(proj, home);
    if (!gate) return null;
    const { level, word } = resolveLevel({ env, home, sessionId: input.session_id });
    if (level < 2) return null;

    // BAJZI_SANDBOX=1 (a Linux `split` session): the Edit tools are the only unsandboxed write path, so they get the narrow list.
    // Anything wider (~/.claude/hooks, ~/.gitconfig) lets a Write turn the excluded `git commit` into an unsandboxed hook run.
    const sandbox = env.BAJZI_SANDBOX === '1';
    // ponytail: in a split session the Edit tools write only runtime/ and memory, places the sandboxed shell cannot write, so no link can be
    // planted and no check-then-write race exists. The tmpdir is NOT in that list (the sandboxed shell writes it). The Windows tier (no sandbox)
    // keeps tmpdir allowed: an accepted limit there.
    const dirs = sandbox ? [path.join(proj, 'runtime')] : [path.join(proj, 'runtime'), path.join(home, '.claude'), tmpdir];
    const memory = String(env.CLAUDE_CONFIG_DIR || '') ? path.join(env.CLAUDE_CONFIG_DIR, 'projects') : path.join(home, '.claude', 'projects');
    // Absolute but NOT collapsed: realPath resolves the raw components (a link before a later `..`), as the OS does.
    const abs = p => {
      let q = p;
      for (const [re, dir] of [[HOME_VAR, home], [TMP_VAR, tmpdir]]) q = q.replace(re, () => dir);
      if (process.platform === 'win32') q = q.replace(/^\/tmp(?=$|\/)/, () => tmpdir).replace(/^\/([a-zA-Z])(?=$|\/)/, '$1:');   // Git-Bash /tmp and /c/Users; on POSIX /tmp is itself
      return path.isAbsolute(q) ? q : `${cwd}/${q}`;
    };
    // The most specific root wins: the longest prefix among the project and the allowed dirs (a tie goes to the project, listed first), so
    // inside the project only runtime/ is allowed, while memory/~/.claude/tmpdir stay allowed when they lie inside a $HOME or ~/.claude project.
    const allowed = p => {
      const k = key(abs(p));
      const mem = key(memory);
      let best = -1;
      let ok = false;
      for (const [d, yes] of [[proj, false], ...dirs.map(d => [d, true]), ...(sandbox ? [[memory, /^[^/]+\/memory\/./.test(k.slice(mem.length + 1))]] : [])]) {
        const dk = key(d);
        if (k.startsWith(`${dk}/`) && dk.length > best) { best = dk.length; ok = yes; }
      }
      return ok;
    };
    // Files that switch the hooks off or lower the level: denied even inside the allowed dirs. Matched on the literal path AND the
    // real path (either = protected), so a link in the canonical place, or a linked dir above it, does not hide the name.
    const claude = path.join(home, '.claude');
    const sets = [lex, key].map(f => ({
      f,
      files: [path.join(proj, 'runtime', 'bajzi-mode'), path.join(cwd, 'runtime', 'bajzi-mode'), env.CC_WORKER_MODE_FILE || '',
        ...['bajzi-mode', 'worker-mode', 'cc-router.json'].map(n => path.join(claude, n))].filter(Boolean).map(f),
      levelDirs: [path.join(env.BAJZI_HOME || home, '.claude', 'bajzi', 'sessions'), path.join(claude, 'bajzi', 'sessions'), env.BAJZI_STATUS_DIR || ''].filter(Boolean).map(f),
      settingsDirs: [claude, path.join(proj, '.claude')].map(f),
      plugins: f(path.join(claude, 'plugins')),
    }));
    const protectedPath = p => {
      const a = abs(p);
      return sets.some(s => {
        const k = s.f(a);
        const dir = path.dirname(k);
        const base = path.basename(k);
        return s.files.includes(k) || k.startsWith(`${s.plugins}/`) ||
          (s.levelDirs.includes(dir) && base.endsWith('.level')) || (s.settingsDirs.includes(dir) && /^settings.*\.json$/.test(base));
      });
    };
    const blocked = reason => {
      logLine(proj, now, word, 'blocked', tool);
      return { kind: 'deny', rule: RULE, reason };
    };

    let write = false;
    if (isEdit) {
      const raw = tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
      if (typeof raw !== 'string' || !raw) return null;
      try { realPath(abs(raw)); } catch { return blocked(UNRESOLVED_REASON); }   // fail closed for this check only
      if (protectedPath(raw)) return blocked(PROTECTED_REASON);   // never relaxes, not even in peak
      // Outside the project, a tmpdir nested inside it (the shell writes it), and the project's .git/.githooks (the excluded `git commit` runs hooks and git config unsandboxed): no risk-agent or peak relaxation.
      if (sandbox && ((!allowed(raw) && !under(abs(raw), proj)) || (under(abs(raw), tmpdir) && key(tmpdir).length > key(proj).length) || [path.join(proj, '.git'), path.join(proj, '.githooks')].some(d => key(abs(raw)) === key(d) || under(abs(raw), d)))) return blocked(SPLIT_REASON);
      write = !allowed(raw) && !(typeof input.agent_type === 'string' && RISK_AGENT.test(input.agent_type));
    } else if (isAgent) {
      const t = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
      write = !(BUILTIN_AGENTS.has(t) || BAJZI_AGENTS.has(t.toLowerCase()));
    } else {
      if (typeof ti.command !== 'string') return null;
      const cmd = ti.command.replace(/\\\r?\n/g, ' ');   // bash joins a backslash-newline
      // Quoted and heredoc text is data, unless a shell/eval wrapper may run it.
      const bare = stripHeredoc(cmd);
      if (WORKER_LEVEL.test(inert(bare)) || [...bare.matchAll(WRAP_ARG)].some(m => WORKER_LEVEL.test(m[1] ?? m[2]))) return blocked(LEVEL_REASON);   // never relaxes, not even in peak
      if (env.BAJZI_SANDBOX === '1') return null;   // Linux `split` session: the OS sandbox judges shell writes, no heuristic false denies
      const w = shellWrites(cmd, allowed, protectedPath);
      if (w === 2) return blocked(PROTECTED_REASON);
      write = w === 1;
    }
    if (!write) return null;
    if (peakStatus(now.getTime()).inPeak) {
      logLine(proj, now, word, 'peak', tool);
      return null;
    }
    return blocked(blockedReason(level));
  } catch {
    return null;
  }
}

function main() {
  runHook('saver-guard', () => {
    const d = check(readInput());
    if (d) deny(d.reason, d.rule);
  });
}

if (require.main === module) main();

module.exports = { check };
