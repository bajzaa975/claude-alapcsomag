'use strict';
// PreToolUse kill guard for Bash and PowerShell. Denies by-name process kills (taskkill /IM|/FI,
// pkill, killall, Stop-Process -Name, Get-Process <name> | Stop-Process / .Kill(), kill fed by
// pgrep/pidof, wmic process delete, Win32_Process Terminate), also inside bash -c / cmd /c /
// powershell -Command. Kills by PID pass. Pattern guard, not a shell parser: variable/command
// indirection and encoded commands pass. No off switch. Fails open.
const { readInput, deny, runHook } = require('./lib/hook-io');
// Libs other than hook-io load inside runHook (F4): a partial install still fails open.
let rules;
function loadLibs() { rules = require('./lib/secret-rules'); }

// Shell keywords that may precede a command word (`then pkill`, `do killall`, `! pkill`).
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', 'timeout', 'xargs']);
// Per prefix: the flags that take a separate value (sudo -n/-k/-s take none).
const VALUE_FLAGS = {
  sudo: new Set(['-u', '-g', '-C', '-U', '-p', '-D', '-r', '-t', '-T']),
  env: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-a']),
};
// A word a pipeline feeds into: `$` (a split `$(...)`), `$_`, `$_.Id`, `$PSItem.Id`.
const PIPE_VAR = /^\$(?:_|psitem)?(?:\.|$)/i;
// A word holding a command substitution (a double-quoted one stays one word).
const SUBST = /\$\(|`/;
// `<<DELIM` line kept, its body through the closing DELIM line dropped.
const HEREDOC = /(<<-?[ \t]*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
// kill flags whose value is a signal, not a target.
const SIGNAL_FLAGS = new Set(['-s', '-n', '--signal']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/i;
const PS_KILLERS = new Set(['stop-process', 'spps', 'kill']);
const GET_PROCESS = new Set(['get-process', 'gps', 'ps']);
const WMI = new Set(['get-ciminstance', 'gcim', 'get-wmiobject', 'gwmi', 'invoke-cimmethod', 'icim', 'invoke-wmimethod']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd']);
const MAX_DEPTH = 4;

function name(w) {
  return rules.baseName(w).toLowerCase().replace(/\.exe$/, '');
}

// `-Name`, `-N`, `-name:x` etc.: the word abbreviates `full` with at least `min` letters.
function param(w, full, min) {
  const m = /^-([a-z]+)(?::.*)?$/i.exec(w);
  return !!m && m[1].length >= min && full.startsWith(m[1].toLowerCase());
}

// The bodies of `$(...)` and backtick substitutions outside single quotes: the splitter keeps a
// double-quoted one inside one word, so its commands would never head a segment.
function substitutions(cmd) {
  const out = [];
  let sq = false;
  let dq = false;
  // A quoted-delimiter heredoc body is literal text: its `$(` and backticks never run.
  cmd = cmd.replace(HEREDOC, (m, line, q) => (q ? line : m));
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && !sq) i++;   // an escaped `, $ or quote is literal
    else if (ch === "'" && !dq) sq = !sq;
    else if (ch === '"' && !sq) dq = !dq;
    else if (sq) continue;
    else if (ch === '$' && cmd[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')' && --depth === 0) break;
      }
      // A heredoc body is data (a commit message), not commands. Nested ones are found as the scan goes on.
      out.push(cmd.slice(i + 2, j).replace(HEREDOC, '$1'));
    } else if (ch === '`') {
      const j = cmd.indexOf('`', i + 1);
      out.push(cmd.slice(i + 1, j < 0 ? cmd.length : j));
      if (j < 0) break;
      i = j;
    }
  }
  return out;
}

// The command a segment runs, past sudo/env/nice/nohup/timeout/xargs (+ their flags), VAR=1,
// PowerShell `$x =`, rtk proxy|err|test.
function head(words) {
  let i = 0;
  let xargs = false;
  while (i < words.length) {
    const w = words[i];
    const n = name(w);
    if (ASSIGNMENT.test(w) || KEYWORDS.has(n)) { i++; continue; }
    if (w.startsWith('$') && words[i + 1] === '=') { i += 2; continue; }
    if (n === 'rtk') { i++; if (/^(proxy|err|test)$/i.test(words[i] || '')) i++; continue; }
    if (!PREFIXES.has(n)) break;
    if (n === 'command' && /^-[a-z]*v/i.test(words[i + 1] || '')) return null;   // command -v: a lookup
    if (n === 'xargs') xargs = true;
    i++;
    const vf = VALUE_FLAGS[n];
    while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT.test(words[i]) ||
      (n === 'xargs' && /^\d+$/.test(words[i])))) {
      i += vf && vf.has(words[i]) ? 2 : 1;
    }
    if (n === 'timeout' && DURATION.test(words[i] || '')) i++;
  }
  return i < words.length ? { name: name(words[i]), args: words.slice(i + 1), xargs } : null;
}

// A kill/Stop-Process segment that names no PID of its own, i.e. takes its targets from a pipe
// (`$_`, `$_.Id`, an empty `-Id (...)`) or a `$(...)`/backtick substitution.
function fedKill(c) {
  if (c.xargs) return c.name === 'kill';
  if (!PS_KILLERS.has(c.name)) return false;
  return !c.args.some((a, k) => !a.startsWith('-') && !PIPE_VAR.test(a) && !SUBST.test(a) &&
    !(c.name === 'kill' && SIGNAL_FLAGS.has(c.args[k - 1])));
}

function nestedInner(c) {
  if (!SHELLS.has(c.name)) return null;
  const k = c.args.findIndex(a => (c.name === 'cmd' ? /^(\/\/?|-)[ck]$/i.test(a)
    : c.name === 'powershell' || c.name === 'pwsh' ? param(a, 'command', 1) : /^-[a-z]*c[a-z]*$/i.test(a)));
  return k >= 0 && k < c.args.length - 1 ? c.args.slice(k + 1).join(' ') : null;
}

// A short label of the matched shape, or null.
function killByName(cmd, depth = 0) {
  if (typeof cmd !== 'string' || !cmd.trim() || depth > MAX_DEPTH) return null;
  const segs = rules.segments(cmd).concat(...substitutions(cmd).map(rules.segments));
  const cs = segs.map(head).filter(Boolean);
  let source = false;
  let sink = false;
  let wmiProc = false;
  let terminate = false;
  for (const c of cs) {
    const { name: n, args } = c;
    if (n === 'taskkill' && args.some(a => /^(\/\/?|-)(im|fi)(:|$)/i.test(a))) return 'taskkill by image name or filter';
    if (n === 'pkill' || n === 'killall') return n;
    if (n === 'kill') {
      const k = args.findIndex(a => param(a, 'name', 1) || param(a, 'processname', 2));
      if (k >= 0 && !/^\d+$/.test(args[k + 1] || '')) return 'kill -Name';
    } else if (PS_KILLERS.has(n) && args.some(a => param(a, 'name', 1) || param(a, 'processname', 2))) {
      return 'Stop-Process -Name';
    }
    if (n === 'wmic' && args.some(a => a.toLowerCase() === 'process') &&
      args.some(a => /^(delete|terminate)$/i.test(a))) return 'wmic process delete/terminate';
    if (GET_PROCESS.has(n) && !args.some(a => param(a, 'id', 2))) source = true;
    if (n === 'pgrep' || n === 'pidof') source = true;
    if (fedKill(c) || /\.kill$/i.test(n)) sink = true;
    if (WMI.has(n) && args.some(a => /win32_process/i.test(a))) wmiProc = true;
    if (/^(invoke-cimmethod|icim|invoke-wmimethod)$/.test(n) && args.some(a => /^terminate$/i.test(a))) terminate = true;
    if (/\.terminate$/i.test(n)) terminate = true;
    const inner = nestedInner(c);
    const hit = inner && killByName(inner, depth + 1);
    if (hit) return hit;
  }
  if (source && sink) return 'a process list selected by name piped into a kill';
  if (wmiProc && terminate) return 'Win32_Process Terminate';
  return null;
}

function decide(input) {
  if (!input || typeof input !== 'object' || !/^(?:Bash|PowerShell)$/.test(input.tool_name)) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  return ti ? killByName(ti.command) : null;
}

function reasonFor(shape, tool) {
  return `kill-guard: ${tool} would kill processes by name (${shape}). Stop only processes you started, by the PID you got when you started them (taskkill /PID <pid> /F /T, Stop-Process -Id <pid>, kill <pid>). A by-name kill also hits other sessions, MCP servers and running night runs. If one is truly needed, ask the owner to run it. Note: this is a pattern guard, not a shell parser.`;
}

// The whole check, as main() and pre-tool.js run it: null or {kind:'deny', rule, reason}. May
// throw: callers fail open.
function check(input) {
  loadLibs();
  const shape = decide(input);
  return shape ? { kind: 'deny', rule: 'kill-guard', reason: reasonFor(shape, input.tool_name) } : null;
}

function main() {
  runHook('kill-guard', () => {
    const d = check(readInput());
    if (d) deny(d.reason, d.rule);
  });
}

if (require.main === module) main(); else loadLibs();

module.exports = { check, decide, reasonFor };
