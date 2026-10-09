#!/usr/bin/env node
// cc-router.js - per-process model routing for Claude Code. No proxy, no daemon, no global settings.
// Entry points (thin shims next to this file set CC_ROUTER_ENTRY):
//   worker ...     follows the saver switch: claude|light = plain Claude subscription, glm|tight = Z.ai GLM
//   glm ...        always GLM
//   ccr code ...   compatibility with the old claude-code-router launcher: always non-Claude
//                  (--model deepseek-* goes to DeepSeek, everything else to GLM)
//   split ...      L2 split session: Claude orchestrates, GLM writes (CC_WORKER_MODE=glm); OS sandbox on Linux
// In GLM mode the Claude aliases are remapped, so callers never change their arguments:
//   top-level (not launched from inside Claude Code): --model sonnet|opus and the main session -> glm_orchestrator_model
//   nested (CLAUDECODE set, e.g. a `glm -p` worker): --model sonnet|opus and the main session -> glm_model
//   both: sub-agents (CLAUDE_CODE_SUBAGENT_MODEL) -> glm_model      --model haiku -> glm_fast_model
// State (all under ~/.claude):  worker-mode (claude|light|glm|tight)   cc-router.json (models)   cc-router.log
//   bajzi/sessions/<session_id>.level  the level of ONE session (--level/--set from inside it)
'use strict';
const VERSION = '1.2.0';
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const DIR = path.join(os.homedir(), '.claude');
const MODE_FILE = process.env.CC_WORKER_MODE_FILE || path.join(DIR, 'worker-mode');
const CONF_FILE = process.env.CC_ROUTER_CONFIG || path.join(DIR, 'cc-router.json');
const ENV_FILE = path.join(DIR, 'cc-router.env');       // optional KEY=VALUE lines, keep it chmod 600
const LOG_FILE = process.env.CC_ROUTER_LOG || path.join(DIR, 'cc-router.log');
const MODES = ['claude', 'light', 'glm', 'tight'];            // L0..L3; 'glm' stays the L2 spelling
const LEVEL_OF = { claude: 0, light: 1, glm: 2, tight: 3 };
const GLM_MODES = ['glm', 'tight'];                            // modes whose MAIN session runs on GLM
const DEFAULTS = { glm_orchestrator_model: 'glm-5.3', glm_model: 'glm-5.3-flash', glm_fast_model: 'glm-5.3-flash' };
const entry = (process.env.CC_ROUTER_ENTRY || 'worker').toLowerCase();
let args = process.argv.slice(2);
const insideClaude = !!process.env.CLAUDECODE;   // nested launch; read BEFORE the env scrub below deletes it

function die(msg, code) { process.stderr.write('[' + entry + '] ' + msg + '\n'); process.exit(code); }
function readConf(raw) { let o = null; try { o = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch (_) {} if (!o || typeof o !== 'object' || Array.isArray(o)) o = {}; return raw ? o : Object.assign({}, DEFAULTS, o); }   // raw: the file only, no defaults
function writeConf(c) { fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true }); fs.writeFileSync(CONF_FILE, JSON.stringify(c, null, 2) + '\n'); }
function models() { const c = readConf(); return { orch: process.env.GLM_ORCHESTRATOR_MODEL || c.glm_orchestrator_model, big: process.env.GLM_MODEL || c.glm_model, fast: process.env.GLM_FAST_MODEL || c.glm_fast_model }; }
function glmMain(m) { return insideClaude ? m.big : m.orch; }   // the opus/sonnet aliases and the default main model
// Per-session level (spec §6.1): <status dir>/<session_id>.level, written by --level/--set from inside a
// Claude session (CLAUDE_CODE_SESSION_ID). KEEP IN SYNC with hooks/node/lib/session-status.js (SAFE_ID,
// statusDir): this file is installed alone into ~/.local/bin, so it cannot require that lib.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUS_DIR = process.env.BAJZI_STATUS_DIR || path.join(process.env.BAJZI_HOME || os.homedir(), '.claude', 'bajzi', 'sessions');
const SID = SAFE_ID.test(process.env.CLAUDE_CODE_SESSION_ID || '') ? process.env.CLAUDE_CODE_SESSION_ID : '';   // unsafe id = no session
const SESSION_FILE = SID ? path.join(STATUS_DIR, SID + '.level') : '';
// The hooks' read (lib-saver-level.sh): first line, one leading BOM dropped, every ASCII whitespace removed, lowercased.
function readWord(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n')[0].replace(/^\uFEFF/, '').replace(/[ \t\n\v\f\r]/g, '').toLowerCase(); } catch (_) { return ''; }
}
// CC_WORKER_MODE > the session level file > BAJZI_SESSION_LEVEL (inherited from a parent session) > worker-mode > claude. An unknown word in a file or in BAJZI_SESSION_LEVEL reads as claude.
function resolveMode() {
  const e = (process.env.CC_WORKER_MODE || '').trim().toLowerCase();
  if (e) { if (!MODES.includes(e)) die('CC_WORKER_MODE must be one of: ' + MODES.join(', '), 64); return { mode: e, src: 'env CC_WORKER_MODE' }; }
  const s = SESSION_FILE ? readWord(SESSION_FILE) : '';
  if (s) return { mode: MODES.includes(s) ? s : 'claude', src: 'session ' + SID };
  const i = (process.env.BAJZI_SESSION_LEVEL || '').replace(/[ \t\n\v\f\r]/g, '').toLowerCase();
  if (i) return { mode: MODES.includes(i) ? i : 'claude', src: 'session (inherited)' };
  const f = readWord(MODE_FILE);
  if (f) return { mode: MODES.includes(f) ? f : 'claude', src: 'machine default ' + MODE_FILE };
  return { mode: 'claude', src: 'none' };
}
function readMode() { return resolveMode().mode; }
// --level/--set: the session file when inside a session, else (or with --global) worker-mode. Atomic: tmp + rename.
const NOSWITCH = ' The level does not switch the provider of a session that is already running: a GLM session starts with worker (or glm).';
function writeLevel(name) {
  const target = args.includes('--global') || !SESSION_FILE ? MODE_FILE : SESSION_FILE;
  const tmp = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let created = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, name + '\n', { flag: 'wx' }); created = true;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (created) { try { fs.unlinkSync(tmp); } catch (_) {} }
    die('cannot write ' + target + ': ' + e.message, 73);
  }
  const n = LEVEL_OF[name];
  if (target === SESSION_FILE) console.log('worker mode = ' + name + '   level L' + n + ' for this session (' + SID + '); other sessions unchanged. Use --level N --global for the machine default.' + NOSWITCH);
  else console.log('worker mode = ' + name + '   level L' + n + ' (' + name + '), machine default (' + MODE_FILE + '); running sessions that set their own level keep it.' + NOSWITCH);
}
function secret(name) {   // 1. process env  2. Windows: User env in the registry (covers already-open apps)  3. ~/.claude/cc-router.env
  if (process.env[name]) return process.env[name];
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m); if (m) return m[1];
    } catch (_) {}
  }
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/); if (m && m[1] === name && m[2]) return m[2];
    }
  } catch (_) {}
  return '';
}
function modelArg(a) { const i = a.indexOf('--model'); if (i >= 0 && a[i + 1]) return a[i + 1]; const j = a.find(x => x.startsWith('--model=')); return j ? j.slice(8) : ''; }
function effective(provider, req) {
  if (provider === 'claude') return req || '(session default)';
  if (provider === 'deepseek') return req || 'deepseek-v4-pro';
  const m = models(), r = (req || '').toLowerCase().replace(/\[.*$/, '');
  if (!r || r === 'sonnet' || r === 'opus') return glmMain(m); if (r === 'haiku') return m.fast; return req;
}
function logLaunch(provider, req, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) {}
    const headless = args.includes('-p') || args.includes('--print');
    fs.appendFileSync(LOG_FILE, [new Date().toISOString(), 'entry=' + entry, 'provider=' + provider, 'asked=' + (req || '-'),
      'model=' + effective(provider, req), headless ? 'headless' : 'interactive'].concat(extra || [], 'cwd=' + process.cwd()).join(' ') + '\n');
  } catch (_) {}
}
const okModel = s => /^[A-Za-z0-9._:\[\]-]{2,64}$/.test(s || '');

// --- usage report: approximates how many tokens went to GLM/Z.ai instead of Anthropic,
// by scanning Claude Code's own local transcripts. Zero LLM calls. ---
const USAGE_HELP = 'usage: worker --usage [since] [--until <t>] [--json]   since: 24h | 30m | 8h | 2d | today | 2026-09-21 | 2026-09-21T18:00 (default 24h)   --until <t>: exclusive upper bound; relative forms (2h) mean that long ago';
function parseSince(raw) {
  const now = new Date();
  if (!raw) raw = '24h';
  let m = /^(\d+)(m|h|d)$/i.exec(raw);
  if (m) {
    const n = parseInt(m[1], 10), unit = m[2].toLowerCase();
    const ms = unit === 'm' ? n * 60000 : unit === 'h' ? n * 3600000 : n * 86400000;
    return new Date(now.getTime() - ms);
  }
  if (/^today$/i.test(raw)) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}
function fmtLocal(d) {
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
function padR(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }
function usageBucket(model) {
  const m = (model || '').toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('glm') || m.includes('deepseek')) return 'glm';
  return 'other';
}
const NAME_W = 26, MAX_ROWS = 8;   // 26 fits "claude-haiku-4-5-20251001"; 8 rows keeps the table within the 12-line budget
function fitName(s) { s = String(s); return s.length > NAME_W ? s.slice(0, NAME_W - 1) + '…' : s; }
function usageWeighted(u) { return u.input * 1 + u.cache_create * 1.25 + u.cache_read * 0.1 + u.output * 5; }
function listJsonl(dir) {
  let out = [], entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listJsonl(p));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
function collectUsage(root, since, until) {
  const files = listJsonl(root);
  const dedup = new Map();
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      const s = line.trim(); if (!s) continue;
      let obj; try { obj = JSON.parse(s); } catch (_) { continue; }
      if (!obj || obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg || typeof msg.usage !== 'object' || msg.usage === null) continue;
      if (typeof obj.timestamp !== 'string') continue;
      const t = new Date(obj.timestamp);
      if (isNaN(t.getTime()) || t < since || (until && t >= until)) continue;
      const u = msg.usage;
      const key = obj.requestId || msg.id || obj.uuid || Symbol('line');
      dedup.set(key, {
        model: msg.model || '(unknown)',
        input: Number(u.input_tokens) || 0,
        cache_create: Number(u.cache_creation_input_tokens) || 0,
        cache_read: Number(u.cache_read_input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
      });
    }
  }
  return { files: files.length, entries: [...dedup.values()] };
}
function usageModels(entries) {
  const models = Object.create(null);   // null prototype: a model literally named "constructor"/"__proto__" must not be dropped
  for (const e of entries) {
    const m = models[e.model] || (models[e.model] = { reqs: 0, input: 0, cache_create: 0, cache_read: 0, output: 0, weighted: 0 });
    m.reqs++; m.input += e.input; m.cache_create += e.cache_create; m.cache_read += e.cache_read; m.output += e.output;
    m.weighted += usageWeighted(e);
  }
  return models;
}
function usageBuckets(models) {
  const raw = { anthropic: 0, glm: 0, other: 0 };
  for (const name of Object.keys(models)) raw[usageBucket(name)] += models[name].weighted;
  const total = raw.anthropic + raw.glm + raw.other;
  const pct = v => total ? Math.round((v / total) * 100) : 0;
  return {
    anthropic: { weighted: raw.anthropic, share: pct(raw.anthropic) },
    glm: { weighted: raw.glm, share: pct(raw.glm) },
    other: { weighted: raw.other, share: pct(raw.other) },
  };
}
function cmdUsage(rest) {
  const ui = rest.indexOf('--until');
  let until = null;
  if (ui >= 0) {
    until = parseSince(rest[ui + 1]);
    if (!rest[ui + 1] || rest[ui + 1].startsWith('--') || !until) die('--until needs a time\n' + USAGE_HELP, 64);
    rest = rest.slice(0, ui).concat(rest.slice(ui + 2));
  }
  const bad = rest.find(x => x.startsWith('--') && x !== '--json');
  if (bad) die('unknown option ' + bad + '\n' + USAGE_HELP, 64);
  const jsonMode = rest.includes('--json');
  const sinceRaw = rest.find(x => x !== '--json');
  const since = parseSince(sinceRaw);
  if (!since) die(USAGE_HELP, 64);
  const root = process.env.CC_PROJECTS_DIR || path.join(DIR, 'projects');
  const { files, entries } = collectUsage(root, since, until);
  const models = usageModels(entries);
  const bk = usageBuckets(models);
  const requests = entries.length;
  if (jsonMode) {
    const out = { since: fmtLocal(since), since_iso: since.toISOString(), until: until ? fmtLocal(until) : null, until_iso: until ? until.toISOString() : null, files, requests, models: Object.create(null),
      buckets: { anthropic: { weighted: Math.round(bk.anthropic.weighted), share: bk.anthropic.share },
        glm: { weighted: Math.round(bk.glm.weighted), share: bk.glm.share },
        other: { weighted: Math.round(bk.other.weighted), share: bk.other.share } },
      glm_share_pct: bk.glm.share };
    for (const k of Object.keys(models)) {
      const m = models[k];
      out.models[k] = { reqs: m.reqs, input: m.input, cache_create: m.cache_create, cache_read: m.cache_read, output: m.output, weighted: Math.round(m.weighted) };
    }
    console.log(JSON.stringify(out, null, 2));
    return true;
  }
  console.log('usage since ' + fmtLocal(since) + ' (local)' + (until ? '  until ' + fmtLocal(until) : '') + '   files=' + files + ' requests=' + requests);
  console.log(padR('model', NAME_W) + padL('reqs', 7) + padL('input', 12) + padL('cache_cr', 12) + padL('cache_rd', 12) + padL('output', 11) + padL('weighted', 13));
  const names = Object.keys(models).sort((a, b) => models[b].weighted - models[a].weighted);
  for (const name of names.slice(0, MAX_ROWS)) {
    const m = models[name];
    console.log(padR(fitName(name), NAME_W) + padL(fmtInt(m.reqs), 7) + padL(fmtInt(m.input), 12) + padL(fmtInt(m.cache_create), 12) + padL(fmtInt(m.cache_read), 12) + padL(fmtInt(m.output), 11) + padL(fmtInt(m.weighted), 13));
  }
  const hidden = names.length - MAX_ROWS;
  console.log(hidden > 0 ? '... and ' + hidden + ' more model' + (hidden === 1 ? '' : 's') : '----');   // keeps the report at <= 12 lines below the header
  console.log('anthropic  weighted=' + fmtInt(bk.anthropic.weighted) + ' (' + bk.anthropic.share + '%)   glm  weighted=' + fmtInt(bk.glm.weighted) + ' (' + bk.glm.share + '%)   other ' + fmtInt(bk.other.weighted));
  console.log('approx. Max quota avoided by GLM: ' + bk.glm.share + '%  (weighted = in*1 + cache_create*1.25 + cache_read*0.1 + out*5)');
  return true;
}

function workerAdmin() {
  const a0 = (args[0] || '').replace(/^--/, '');
  if (a0 === 'mode') { console.log(readMode()); return true; }
  const val = args.slice(1).filter(x => x !== '--global')[0];   // --global may sit before or after the value
  if (a0 === 'set') {
    const m = (val || '').toLowerCase(); if (!MODES.includes(m)) die('usage: worker --set ' + MODES.join('|') + ' [--global]', 64);
    writeLevel(m); return true;
  }
  if (a0 === 'level') {
    const n = val; const name = MODES[Number(n)];
    if (!/^[0-3]$/.test(n || '') || !name) die('usage: worker --level 0|1|2|3 [--global]   (0 claude, 1 light, 2 glm, 3 tight)', 64);
    writeLevel(name); return true;
  }
  const KEY = { 'set-model': 'glm_model', 'set-fast-model': 'glm_fast_model', 'set-orchestrator-model': 'glm_orchestrator_model' }[a0];
  if (KEY) {
    if (!okModel(args[1])) die('usage: worker --' + a0 + ' <model-id>   e.g. worker --' + a0 + ' glm-5.4', 64);
    const raw = readConf(true); raw[KEY] = args[1]; writeConf(raw); const c = readConf();   // write only the set key; defaults stay code-side
    console.log('glm_orchestrator_model = ' + c.glm_orchestrator_model + '   glm_model = ' + c.glm_model + '   glm_fast_model = ' + c.glm_fast_model); return true;
  }
  if (a0 === 'usage') return cmdUsage(args.slice(1));
  if (a0 === 'log') {
    const n = parseInt(args[1], 10) || 10;
    try { console.log(fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-n).join('\n')); } catch (_) { console.log('(no launches logged yet)'); }
    return true;
  }
  if (a0 === 'status') {
    const m = models();
    const { mode: md, src } = resolveMode();
    console.log('level           L' + LEVEL_OF[md] + ' (' + md + ')   (' + src + ')');
    console.log('mode            ' + md);
    console.log('orchestrator    ' + m.orch + (process.env.GLM_ORCHESTRATOR_MODEL ? '   (forced by GLM_ORCHESTRATOR_MODEL)' : ''));
    console.log('glm model       ' + m.big + (process.env.GLM_MODEL ? '   (forced by GLM_MODEL)' : ''));
    console.log('glm fast model  ' + m.fast + (process.env.GLM_FAST_MODEL ? '   (forced by GLM_FAST_MODEL)' : ''));
    console.log('ZAI_API_KEY     ' + (secret('ZAI_API_KEY') ? 'found' : 'MISSING'));
    console.log('claude binary   ' + claudeExe());
    console.log('router          v' + VERSION + '   ' + __filename);
    console.log('files           ' + MODE_FILE + ' | ' + CONF_FILE + ' | ' + LOG_FILE + (SESSION_FILE ? ' | ' + SESSION_FILE : ''));
    return true;
  }
  if (a0 === 'router-help') {
    console.log('worker --status | --mode | --level 0|1|2|3 [--global] | --set claude|light|glm|tight [--global] | --set-orchestrator-model <id> | --set-model <id> | --set-fast-model <id> | --log [n] | --usage [since] [--json]\nanything else is passed to Claude Code unchanged, e.g.  worker -p "..." --model sonnet'); return true;
  }
  return false;
}
function claudeExe() {
  if (process.env.CC_CLAUDE_BIN) return process.env.CC_CLAUDE_BIN;
  if (process.platform === 'win32') { const p = path.join(os.homedir(), '.local', 'bin', 'claude.exe'); if (fs.existsSync(p)) return p; }
  return 'claude';
}
let PREFIX = [];   // test seam: prefix args for the fake claude; inert when unset; bad JSON or a non-array is ignored
if (process.env.CC_CLAUDE_PREFIX_ARGS) { try { PREFIX = JSON.parse(process.env.CC_CLAUDE_PREFIX_ARGS); } catch (_) { PREFIX = []; } }
if (!Array.isArray(PREFIX)) PREFIX = [];
let provider, sessionMode = '';   // sessionMode: the level a session file chose; the child has a new session id and would not find it
if (entry === 'ccr') {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'code') { args = args.slice(1); provider = /^deepseek/i.test(modelArg(args)) ? 'deepseek' : 'glm'; }
  else if (['start', 'stop', 'restart', 'status', 'ui', 'serve', 'web', '-v', '--version', 'version'].includes(sub)) {
    console.log('ccr shim (cc-router v' + VERSION + '): no router service is needed; "ccr code" routes per process. Nothing to ' + (sub || 'do') + '.'); process.exit(0);
  } else die('this is the cc-router shim; only "ccr code [claude args]" is supported (got: ' + (sub || 'nothing') + ')', 64);
} else if (entry === 'glm') { provider = 'glm'; }
else if (entry === 'split') {   // the main session stays on the Claude subscription: no level read, no peak refusal
  if (args.some(a => a === '--settings' || a.startsWith('--settings='))) die('split passes its own --settings (the OS sandbox); drop yours, or start plain claude', 64);
  provider = 'claude';
} else { if (workerAdmin()) process.exit(0); const rm = resolveMode(); provider = GLM_MODES.includes(rm.mode) ? 'glm' : 'claude'; if (rm.src.startsWith('session')) sessionMode = rm.mode; }

function peakOpen(now) { const h = now.getUTCHours(); return h >= 6 && h < 10; }   // 14:00-18:00 UTC+8, Z.ai 3x quota
if (provider === 'glm' && process.env.CC_GLM_PEAK_OK !== '1') {
  let now = process.env.CC_ROUTER_NOW ? new Date(process.env.CC_ROUTER_NOW) : new Date();   // CC_ROUTER_NOW: test clock (ISO)
  if (isNaN(now.getTime())) now = new Date();   // a garbage override must not silently disable the check
  if (peakOpen(now)) {
    const log = process.env.CC_PEAK_LOG || path.join(DIR, 'glm-peak-refusals.log');
    try { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, now.toISOString() + ' entry=' + entry + '\n'); } catch (_) {}
    die('GLM refused: Z.ai peak window 14:00-18:00 UTC+8 (' + fmtLocal(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6))) +
        '-' + fmtLocal(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10))) + ' local) costs 3x quota. ' +
        'Do this task on Claude instead, or set CC_GLM_PEAK_OK=1 to override.', 75);
  }
}

const env = Object.assign({}, process.env);
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDECODE$|CC_ROUTER_ENTRY$|CC_ROUTER_WORKER$)/.test(k)) delete env[k];
const asked = modelArg(args);

if (provider === 'glm') {
  const key = secret('ZAI_API_KEY'); if (!key) die('ZAI_API_KEY not found (environment variable, or a line in ' + ENV_FILE + ').', 78);
  const m = models();
  Object.assign(env, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_OPUS_MODEL: glmMain(m), ANTHROPIC_DEFAULT_SONNET_MODEL: glmMain(m), ANTHROPIC_DEFAULT_HAIKU_MODEL: m.fast,
    CLAUDE_CODE_SUBAGENT_MODEL: m.big, API_TIMEOUT_MS: '3000000', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1' });   // GLM ids are not in Claude Code's model catalog; silences the yellow warning
  if (!asked) env.ANTHROPIC_MODEL = glmMain(m);
  if (!args.some(a => a === '--settings' || a.startsWith('--settings='))) {   // Claude Code resolves a GLM id (and skips the [claude-code:unrecognized_model] stderr warning) only through the modelOverrides setting
    const ov = {};   // catalog id -> GLM id; values stay unique: when two roles share a model (default glm_model = glm_fast_model) the first key wins
    for (const [k, v] of [['claude-opus-4-1', m.orch], ['claude-haiku-4-5', m.fast], ['claude-sonnet-4-5', m.big]]) if (!Object.values(ov).includes(v)) ov[k] = v;
    args = ['--settings', JSON.stringify({ modelOverrides: ov })].concat(args);
  }
} else if (provider === 'deepseek') {   // UNTESTED path: keeps old "ccr code --model deepseek-*" calls failing clearly or working
  const key = secret('DEEPSEEK_API_KEY'); if (!key) die('DEEPSEEK_API_KEY not found (environment variable, or a line in ' + ENV_FILE + ').', 78);
  const m = asked || 'deepseek-v4-pro';
  Object.assign(env, { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: m, API_TIMEOUT_MS: '3000000', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  if (!asked) env.ANTHROPIC_MODEL = m;
}   // provider === 'claude': plain Claude Code on the subscription; env already scrubbed of ANTHROPIC_*
if (sessionMode) env.BAJZI_SESSION_LEVEL = sessionMode;   // sets the level, never opens the saver gate
if (insideClaude) env.CC_ROUTER_WORKER = '1';   // B2: tells a Claude-spawned `glm -p` worker from a main session

const PLATFORM = process.env.CC_ROUTER_PLATFORM || process.platform;   // test seam: the platform the split entry sees

// --- split entry helpers ---
// Only what must write into the project: the GLM worker, the two git commands that record its work, the findings CLI. Every other git
// or gh call is GLM's job in a split session: `fetch --upload-pack=`, `push --receive-pack=`, `fetch <tmp clone> + switch -c` and
// `gh alias set --shell` each turn an excluded (unsandboxed) command into an arbitrary write or exec.
const EXCLUDED = ['glm *', 'git add *', 'git commit *'];
function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).some(d => {
    if (!d) return false;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
  });
}
let BWRAP = ['bwrap'];   // test seam: CC_BWRAP_CMD = JSON [cmd, ...leading args] replaces bwrap; a bad value is ignored
try { const a = JSON.parse(process.env.CC_BWRAP_CMD); if (Array.isArray(a) && a.length && a.every(x => typeof x === 'string')) BWRAP = a; } catch (_) {}
// '' when bwrap can create a namespace (stock Ubuntu 23.10+ refuses unprivileged ones without an AppArmor profile), else why not.
function bwrapProbe() {
  const r = spawnSync(BWRAP[0], BWRAP.slice(1).concat(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true']),
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
  if (!r.error && r.status === 0) return '';
  return ((r.stderr || '').split('\n').find(l => l.trim()) || (r.error ? r.error.message : r.signal ? 'killed by ' + r.signal : 'exit ' + r.status)).trim();
}
function projectRoot() {
  try { const r = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (r) return r; } catch (_) {}
  return process.cwd();
}
// The installed bajzi root: installPath of the newest `bajzi@<marketplace>` entry this session loads, from
// installed_plugins.json under CLAUDE_CONFIG_DIR (else ~/.claude): a user-scope entry, or a project/local one whose
// projectPath is this project. Absolute, no `..` segment, no `*`, and <root>/lib/findings-cli.js must exist; else ''.
// An exact path only: a wildcard before the script would also match a findings-cli.js planted under the writable /tmp.
function bajziRoot(root) {
  let best = null;
  const t = e => Date.parse(e.lastUpdated || e.installedAt) || 0;
  const norm = p => { const q = path.resolve(String(p)); return process.platform === 'win32' ? q.toLowerCase() : q; };
  const here = [root, process.cwd()].map(norm);
  const loaded = e => !e.scope || e.scope === 'user' || (typeof e.projectPath === 'string' && here.includes(norm(e.projectPath)));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || DIR, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [k, list] of Object.entries((j && j.plugins) || {})) {
      if (!/^bajzi@/.test(k) || !Array.isArray(list)) continue;
      for (const e of list) if (e && typeof e.installPath === 'string' && loaded(e) && (!best || t(e) > t(best))) best = e;
    }
  } catch (_) {}
  const r = best ? best.installPath : '';
  if (!r || !path.isAbsolute(r) || r.split(/[\\/]/).includes('..') || r.includes('*')) return '';
  try { return fs.statSync(path.join(r, 'lib', 'findings-cli.js')).isFile() ? r : ''; } catch (_) { return ''; }
}
// ~/.claude/bajzi/sandbox/split-<sha1(root), 12 hex>.json, rewritten on every launch (tmp + rename, mode 600).
// The whole root is denied: denyWrite beats a narrower allowWrite, and a glob there denied nothing (measured).
function writeSandbox() {
  const root = projectRoot(), plug = bajziRoot(root);
  if (!plug) process.stderr.write('split: bajzi plugin root not found - findings CLI stays sandboxed\n');
  const conf = { sandbox: { enabled: true, allowUnsandboxedCommands: false,
    excludedCommands: EXCLUDED.flatMap(c => [c, 'rtk ' + c]).concat(plug ? ['node ' + plug + '/lib/findings-cli.js *', 'node "' + plug + '/lib/findings-cli.js" *'] : []),
    filesystem: { allowWrite: [...new Set([os.tmpdir(), '/tmp'])], denyWrite: [root] } } };
  const dir = path.join(DIR, 'bajzi', 'sandbox');
  const file = path.join(dir, 'split-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 12) + '.json');
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    die('cannot write the sandbox settings ' + file + ': ' + e.message + ' (not starting without the sandbox)', 73);
  }
  return file;
}

// split (spec §6.2): CC_WORKER_MODE=glm opens the saver gate and pins L2 for the whole process tree. On Linux with
// bwrap + socat the Bash tool also runs in Claude Code's OS sandbox: the project root is read-only, only the
// excluded commands (glm, git add/commit/..., the findings CLI) write. BAJZI_SANDBOX=1 tells the saver guard so.
let marker = '';
if (entry === 'split') {
  delete env.BAJZI_SANDBOX;   // only this launch may claim the sandbox
  Object.assign(env, { CC_WORKER_MODE: 'glm', BAJZI_SPLIT: '1' });
  let sandbox = PLATFORM === 'linux' && onPath('bwrap') && onPath('socat');
  const why = sandbox ? bwrapProbe() : '';
  if (why) { sandbox = false; process.stderr.write('split: bwrap cannot create a namespace (' + why + ') - on Ubuntu add an AppArmor profile for /usr/bin/bwrap; guard tier only\n'); }
  else if (sandbox) { args = ['--settings', writeSandbox()].concat(args); env.BAJZI_SANDBOX = '1'; }
  else process.stderr.write('split: no OS sandbox ' + (PLATFORM === 'linux' ? '(bubblewrap/socat missing)' : 'on ' + PLATFORM) + ' - Windows-tier guard only\n');
  marker = 'split sandbox=' + (sandbox ? 'yes' : 'no');
}

logLaunch(provider, asked, marker);
const exe = claudeExe();
const child = spawn(exe, PREFIX.concat(args), { stdio: 'inherit', env });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch (_) {} });
child.on('error', e => die('cannot start ' + exe + ': ' + e.message, 127));
child.on('exit', (code, sig) => process.exit(sig ? 1 : (code === null ? 1 : code)));
