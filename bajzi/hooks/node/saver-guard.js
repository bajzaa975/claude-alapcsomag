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
const HOME_VAR = /^(?:~|\$\{HOME\}|\$HOME|\$env:(?:HOME|USERPROFILE))(?=$|[/\\])/i;
const TMP_VAR = /^(?:\$\{(?:TMPDIR|TEMP|TMP)\}|\$(?:TMPDIR|TEMP|TMP)|\$env:(?:TMPDIR|TEMP|TMP))(?=$|[/\\])/i;
const LEVEL_REASON = 'saver-guard: only the owner may change the saver level. Ask the owner to type ! worker --level <n> in the prompt (it bypasses hooks).';

// Path key as writer-guard.js: `/` separators, no trailing slash, lower-case on win32.
function key(p) {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
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

    const dirs = [path.join(proj, 'runtime'), path.join(home, '.claude'), tmpdir];
    const abs = p => {
      let q = p;
      for (const [re, dir] of [[HOME_VAR, home], [TMP_VAR, tmpdir], [/^\/tmp(?=$|\/)/, tmpdir]]) q = q.replace(re, () => dir);
      if (process.platform === 'win32') q = q.replace(/^\/([a-zA-Z])(?=$|\/)/, '$1:');   // Git-Bash /c/Users
      return path.resolve(cwd, q);
    };
    const allowed = p => dirs.some(d => under(abs(p), d));
    // Files that switch the hooks off or lower the level: denied even inside the allowed dirs.
    const claude = path.join(home, '.claude');
    const files = [path.join(proj, 'runtime', 'bajzi-mode'), path.join(cwd, 'runtime', 'bajzi-mode'), env.CC_WORKER_MODE_FILE || '',
      ...['bajzi-mode', 'worker-mode', 'cc-router.json'].map(f => path.join(claude, f))].filter(Boolean).map(key);
    const levelDirs = [path.join(env.BAJZI_HOME || home, '.claude', 'bajzi', 'sessions'), path.join(claude, 'bajzi', 'sessions'), env.BAJZI_STATUS_DIR || ''].filter(Boolean).map(key);
    const settingsDirs = [claude, path.join(proj, '.claude')].map(key);
    const protectedPath = p => {
      const a = abs(p);
      const k = key(a);
      const dir = key(path.dirname(a));
      const base = path.basename(k);
      return files.includes(k) || under(a, path.join(claude, 'plugins')) ||
        (levelDirs.includes(dir) && base.endsWith('.level')) || (settingsDirs.includes(dir) && /^settings.*\.json$/.test(base));
    };
    const blocked = reason => {
      logLine(proj, now, word, 'blocked', tool);
      return { kind: 'deny', rule: RULE, reason };
    };

    let write = false;
    if (isEdit) {
      const raw = tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
      if (typeof raw !== 'string' || !raw) return null;
      if (protectedPath(raw)) return blocked(PROTECTED_REASON);   // never relaxes, not even in peak
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
