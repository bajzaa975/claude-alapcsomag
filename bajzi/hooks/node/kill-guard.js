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

const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', 'timeout', 'xargs']);
const VALUE_FLAGS = new Set(['-u', '-g', '-n', '-s', '-k', '-C', '-U']);   // sudo -u, nice -n, timeout -s|-k, env -u
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

// The command a segment runs, past sudo/env/nice/nohup/timeout/xargs (+ their flags), VAR=1,
// PowerShell `$x =`, rtk proxy|err|test.
function head(words) {
  let i = 0;
  let xargs = false;
  while (i < words.length) {
    const w = words[i];
    const n = name(w);
    if (ASSIGNMENT.test(w)) { i++; continue; }
    if (w.startsWith('$') && words[i + 1] === '=') { i += 2; continue; }
    if (n === 'rtk') { i++; if (/^(proxy|err|test)$/i.test(words[i] || '')) i++; continue; }
    if (!PREFIXES.has(n)) break;
    if (n === 'xargs') xargs = true;
    i++;
    while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT.test(words[i]))) {
      i += VALUE_FLAGS.has(words[i]) && !xargs ? 2 : 1;
    }
    if (n === 'timeout' && DURATION.test(words[i] || '')) i++;
  }
  return i < words.length ? { name: name(words[i]), args: words.slice(i + 1), xargs } : null;
}

// A kill/Stop-Process segment that names no PID of its own, i.e. takes its targets from a pipe
// or a `$(...)`/backtick substitution.
function fedKill(c) {
  if (c.xargs) return c.name === 'kill';
  if (!PS_KILLERS.has(c.name)) return false;
  if (c.args.some(a => param(a, 'id', 2))) return false;
  return c.args.includes('$') || !c.args.some(a => !a.startsWith('-') && a !== '$');
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
  const segs = rules.segments(cmd);
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
      const k = args.findIndex(a => param(a, 'name', 1));
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
