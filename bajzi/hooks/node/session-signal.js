'use strict';
// Session-signal hook: writes the status records of spec §6.5 (<id>.event.json, <id>.artifacts.jsonl)
// for the claude-orchestrator workbench. hooks.json runs it on SessionStart, UserPromptSubmit,
// Notification (4 types), Stop, StopFailure, SessionEnd; post-tool.js runs check() in-process on
// every PostToolUse (Artifact append + the resume rule), so no extra process per tool call.
// Fail-open: exit 0, nothing on stdout or stderr, ever; libs other than hook-io load inside
// runHook/runChecks (F4), so a partial install only logs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInput, runHook } = require('./lib/hook-io');

const NEEDS_YOU = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'agent_needs_input']);
const WEEK_MS = 7 * 86400e3;
const SAMPLE_MAX = 2048;
const CLAUDE_URL = /https:\/\/claude\.ai\/[^\s"'<>\\)\]}]*/;

const str = v => (typeof v === 'string' ? v : '');
// Who a hook input (or a stored record) belongs to: a sub-agent's non-empty agent_id, '' = the main
// thread. agent_type is no marker: the main thread of an --agent session carries it too.
const owner = o => (typeof o.agent_id === 'string' ? o.agent_id : '');
// The first n characters, counted in code points: a cut never splits a surrogate pair.
const cut = (s, n) => (s.length <= n ? s : Array.from(s.slice(0, 2 * n)).slice(0, n).join(''));

function readJson(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
}

function record(input, env, nowMs, state, message) {
  const note = input.hook_event_name === 'Notification';
  return {
    v: 1, session_id: input.session_id, event: str(input.hook_event_name), state, message,
    notification_type: note ? str(input.notification_type) : undefined,
    agent_id: note && owner(input) ? owner(input) : undefined,
    cwd: str(input.cwd), transcript_path: str(input.transcript_path), ppid: process.ppid,
    pane_id: env.ORCH_PANE_ID || undefined, entrypoint: env.CLAUDE_CODE_ENTRYPOINT || '',
    ts: Math.floor(nowMs / 1000),
  };
}

function artifact(ss, input, nowMs, dir, id) {
  const r = input.tool_response;
  const m = CLAUDE_URL.exec(typeof r === 'string' ? r : JSON.stringify(r) || '');
  if (!m) return;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const title = str(ti.title) || path.basename(str(ti.file_path) || str(ti.path));
  ss.appendLine(dir, `${id}.artifacts.jsonl`, { v: 1, url: m[0].replace(/[.,;:!?]+$/, ''), title, ts: Math.floor(nowMs / 1000) });
}

// The event file is written whole on every row of the contract table; it is read only by the idle
// rule and the resume rule.
function handle(input, env, nowMs, dir) {
  if (!input || typeof input !== 'object') return;
  const ss = require('./lib/session-status');
  const id = input.session_id;
  if (typeof id !== 'string' || !ss.SAFE_ID.test(id)) return;
  const e = env && typeof env === 'object' ? env : {};
  const file = `${id}.event.json`;
  const prev = () => { const j = readJson(dir, file); return j && typeof j === 'object' ? j : {}; };
  const state = () => prev().state;
  const put = (st, msg) => { ss.writeJson(dir, file, record(input, e, nowMs, st, msg)); };
  switch (input.hook_event_name) {
    case 'SessionStart': ss.prune(dir, WEEK_MS, nowMs); put('appears', 'started'); return;
    case 'UserPromptSubmit': put('working', cut(str(input.prompt), 120)); return;
    case 'Notification':
      if (!NEEDS_YOU.has(input.notification_type)) return;
      // Idle rule: a finished turn going idle is not "needs you".
      if (input.notification_type === 'idle_prompt' && ['done', 'appears', 'problem'].includes(state())) return;
      put('needs_you', cut(str(input.message), 500));
      return;
    case 'Stop': put('done', ''); return;
    case 'StopFailure':
      put('problem', cut(str(input.last_assistant_message) || str(input.error_details) || str(input.error), 500));
      return;
    case 'SessionEnd': put('closed', str(input.reason)); return;
    case 'PostToolUse':
      if (input.tool_name === 'Artifact') artifact(ss, input, nowMs, dir, id);
      // Resume rule: a tool ran in the thread that asked (same agent_id, '' = main thread), so the
      // owner answered the prompt and Claude carries on. Residual: two parallel main-thread tool
      // calls, one waiting on permission, still flip it; no input field ties a prompt to a tool call.
      // A sub-agent's prompt left open (denied, or the tool failed) is cleared when the main thread's
      // Agent/Task call returns: the sub-agent is gone. Residual (spec §6.5): with parallel sub-agents,
      // any one's return clears another's open prompt.
      { const p = prev(), back = !owner(input) && owner(p) && ['Agent', 'Task'].includes(input.tool_name);
        if (p.state === 'needs_you' && (owner(p) === owner(input) || back)) put('working', 'resumed'); }
      return;
    default:
  }
}

const SAMPLE_KEEP = new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'agent_id', 'agent_type',
  'agent_transcript_path', 'tool_name', 'tool_use_id', 'notification_type', 'source', 'reason', 'permission_mode',
  'model', 'stop_hook_active', 'matcher', 'trigger']);

// Shape, never content: a string becomes "<str N>" (N = UTF-16 length) unless it is the value of a
// top-level SAMPLE_KEEP key (kept, cut at SAMPLE_MAX); numbers, booleans, null and keys stay.
function redact(v, top) {
  if (typeof v === 'string') return `<str ${v.length}>`;
  if (Array.isArray(v)) return v.map(x => redact(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, top && SAMPLE_KEEP.has(k) && typeof x === 'string' ? cut(x, SAMPLE_MAX) : redact(x)]));
  }
  return v;
}

// Diagnostics, owner-switched: while <home>/.claude/bajzi/hook-samples.on exists, every hook input
// is appended redacted (redact(): payload shape plus the SAMPLE_KEEP ids, never prompt, tool or
// message content) to hook-samples.jsonl next to it. BAJZI_HOME = home.
function sample(input, env) {
  try {
    const dir = path.join((env && env.BAJZI_HOME) || os.homedir(), '.claude', 'bajzi');
    if (input && typeof input === 'object' && fs.existsSync(path.join(dir, 'hook-samples.on'))) {
      require('./lib/session-status').appendLine(dir, 'hook-samples.jsonl', redact(input, true));
    }
  } catch { /* diagnostics never break the hook */ }
}

// The post-tool.js CHECKS entry and the CLI body. Returns null: never a deny, never a context.
function check(input) {
  sample(input, process.env);
  handle(input, process.env, Date.now(), require('./lib/session-status').statusDir(process.env));
  return null;
}

if (require.main === module) runHook('session-signal', () => { check(readInput()); });

module.exports = { handle, sample, check };
