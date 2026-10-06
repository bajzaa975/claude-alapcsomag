'use strict';
// PreToolUse saver guard (owner decision 2026-10-06): a session at L2/L3 that still runs on Claude
// (started with plain `claude`, not `worker`) may not write code itself; writing is GLM's job
// (`glm -p`). Active only with the saver gate open (CC_WORKER_MODE set, or day-run on: the same
// rule as lib-saver-level.sh:saver_resolve), level >= 2 and an Anthropic provider. Edit/Write
// outside runtime/, ~/.claude/ and tmpdir, a writing sub-agent, and an obvious Bash/PowerShell file
// write are denied; `worker --level/--set` is denied always (the owner uses `! worker --level N`).
// Inside the Z.ai peak window the write denies become counted allows. Every deny and every peak
// allow appends a line to <cwd>/runtime/routing-violations.log. Stdlib only; fails open.
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
const WORKER_LEVEL = /(?:^|[\s;&|(`'"/\\])worker(?:\.cmd)?(?=[\s;&|)`'"]|$)[\s\S]*?--(?:level|set)\b/i;
const SEP = String.raw`(?:^|[\s;&|(])`;   // a command word starts the text or follows a space/separator
const SED_I = new RegExp(String.raw`${SEP}sed(?=\s)[^;&|\n]*?\s(?:-[a-zA-Z]*i|--in-place)`);
const PERL_I = new RegExp(String.raw`${SEP}perl(?=\s)[^;&|\n]*?\s-[a-zA-Z]*i`);
const REDIRECT = /(?:^|[\s;&|(\d&])>>?\|?[ \t]*(&[\d-]|[^\s;&|<>()]+)?/g;
const TEE = /(?:^|[;&|(])\s*tee((?:[ \t]+[^\s;&|<>()]+)*)/g;
const PS_WRITE = new RegExp(String.raw`${SEP}(Set-Content|Add-Content|Out-File|New-Item)(?=\s|$)([^;|\n]*)`, 'gi');
const PS_PATH_OPT = /^-(?:Path|LiteralPath|FilePath)$/i;
const HEREDOC = /(?<!<)<<-?(?!<)[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*(?:[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/g;
const SINKS =/^(?:\/dev\/null|&[\d-]|\$null)$/i;

const blockedReason = n => `saver-guard: this session is at L${n} but runs on Claude (started with plain claude). Writing code is GLM's job here: run it as glm -p with the brief on stdin (Bash run_in_background), or relaunch the session with worker. Risk slices: bajzi:implementer-risk. Owner override: type ! worker --level 0 in the prompt.`;
const LEVEL_REASON = 'saver-guard: only the owner may change the saver level. Ask the owner to type ! worker --level <n> in the prompt (it bypasses hooks).';

// Path key as writer-guard.js: `/` separators, no trailing slash, lower-case on win32.
function key(p) {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
function under(p, dir) {
  return key(p).startsWith(`${key(dir)}/`);
}

// The day-run mode file read of lib-saver-level.sh: the first existing of <cwd>/runtime/bajzi-mode,
// <home>/.claude/bajzi-mode alone decides; head -1, every whitespace removed, ASCII lower-case.
function dayRunOn(cwd, home) {
  for (const f of [path.join(cwd, 'runtime', 'bajzi-mode'), path.join(home, '.claude', 'bajzi-mode')]) {
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

// ponytail: a token heuristic over the command text, not a sandbox. A creative write (python -c,
// cp, git apply, an unknown cmdlet alias) still passes; sed -i/perl -i are denied whatever the
// target. A real shell parser if Claude starts routing around it.
function shellWrites(cmd, allowed) {
  // A heredoc body is data (a glm brief, a commit message), not shell: keep only its header line,
  // which still carries the command's own redirect (`cat <<EOF > src/x.js`).
  cmd = cmd.replace(HEREDOC, m => m.split('\n')[0]);
  // Quoted text goes inert: its metacharacters go, its whitespace becomes `_` (so `-m "a -> b"`
  // holds no redirect, while a quoted redirect target still resolves to a path).
  const s = cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => q.slice(1, -1).replace(/[<>|;&]/g, '').replace(/\s/g, '_'));
  if (SED_I.test(s) || PERL_I.test(s)) return true;
  const ok = t => SINKS.test(t) || allowed(t);
  for (const m of s.matchAll(REDIRECT)) if (m[1] && !ok(m[1])) return true;
  for (const m of s.matchAll(TEE)) {
    if (m[1].trim().split(/\s+/).some(t => t && !t.startsWith('-') && !ok(t))) return true;
  }
  for (const m of s.matchAll(PS_WRITE)) {
    const args = m[2].trim().split(/\s+/).filter(Boolean);
    if (/^New-Item$/i.test(m[1]) && !/(?:^|\s)-ItemType\s+File(?:\s|$)/i.test(m[2])) continue;
    const named = args.findIndex(a => PS_PATH_OPT.test(a));
    const target = named >= 0 ? args[named + 1] : args[0];
    if (!target || target.startsWith('-') || !ok(target)) return true;   // no clear target: deny
  }
  return false;
}

function logLine(cwd, now, word, cause, tool) {
  try {
    const dir = path.join(cwd, 'runtime');
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
    const gate = String(env.CC_WORKER_MODE || '').replace(WS, '') !== '' || dayRunOn(cwd, home);
    if (!gate) return null;
    const { level, word } = resolveLevel({ env, home, sessionId: input.session_id });
    if (level < 2) return null;

    const dirs = [path.join(cwd, 'runtime'), path.join(home, '.claude'), tmpdir];
    const allowed = p => {
      const abs = path.resolve(cwd, p.replace(/^~(?=$|[/\\])/, home));
      return dirs.some(d => under(abs, d));
    };
    const blocked = reason => {
      logLine(cwd, now, word, 'blocked', tool);
      return { kind: 'deny', rule: RULE, reason };
    };

    let write = false;
    if (isEdit) {
      const raw = tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
      if (typeof raw !== 'string' || !raw) return null;
      write = !allowed(raw) && !(typeof input.agent_type === 'string' && RISK_AGENT.test(input.agent_type));
    } else if (isAgent) {
      const t = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
      write = !(BUILTIN_AGENTS.has(t) || BAJZI_AGENTS.has(t.toLowerCase()));
    } else {
      if (typeof ti.command !== 'string') return null;
      if (WORKER_LEVEL.test(ti.command)) return blocked(LEVEL_REASON);   // never relaxes, not even in peak
      write = shellWrites(ti.command, allowed);
    }
    if (!write) return null;
    if (peakStatus(now.getTime()).inPeak) {
      logLine(cwd, now, word, 'peak', tool);
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
