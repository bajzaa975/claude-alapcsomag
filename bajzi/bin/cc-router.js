#!/usr/bin/env node
// cc-router.js - per-process model routing for Claude Code. No proxy, no daemon, no global settings.
// Entry points (thin shims next to this file set CC_ROUTER_ENTRY):
//   worker ...     follows the saver switch: claude|light = plain Claude subscription, glm|tight = Z.ai GLM
//   glm ...        always GLM
//   ccr code ...   compatibility with the old claude-code-router launcher: always non-Claude
//                  (--model deepseek-* goes to DeepSeek, everything else to GLM)
// In GLM mode the Claude aliases are remapped, so callers never change their arguments:
//   --model sonnet|opus -> glm_model      --model haiku -> glm_fast_model
// State (all under ~/.claude):  worker-mode (claude|light|glm|tight)   cc-router.json (models)   cc-router.log
'use strict';
const VERSION = '1.2.0';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const DIR = path.join(os.homedir(), '.claude');
const MODE_FILE = process.env.CC_WORKER_MODE_FILE || path.join(DIR, 'worker-mode');
const CONF_FILE = process.env.CC_ROUTER_CONFIG || path.join(DIR, 'cc-router.json');
const ENV_FILE = path.join(DIR, 'cc-router.env');       // optional KEY=VALUE lines, keep it chmod 600
const LOG_FILE = process.env.CC_ROUTER_LOG || path.join(DIR, 'cc-router.log');
const MODES = ['claude', 'light', 'glm', 'tight'];            // L0..L3; 'glm' stays the L2 spelling
const LEVEL_OF = { claude: 0, light: 1, glm: 2, tight: 3 };
const GLM_MODES = ['glm', 'tight'];                            // modes whose MAIN session runs on GLM
const DEFAULTS = { glm_model: 'glm-5.3', glm_fast_model: 'glm-4.7' };
const entry = (process.env.CC_ROUTER_ENTRY || 'worker').toLowerCase();
let args = process.argv.slice(2);

function die(msg, code) { process.stderr.write('[' + entry + '] ' + msg + '\n'); process.exit(code); }
function readConf() { try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))); } catch (_) { return Object.assign({}, DEFAULTS); } }
function writeConf(c) { fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true }); fs.writeFileSync(CONF_FILE, JSON.stringify(c, null, 2) + '\n'); }
function models() { const c = readConf(); return { big: process.env.GLM_MODEL || c.glm_model, fast: process.env.GLM_FAST_MODEL || c.glm_fast_model }; }
function readMode() {
  const e = (process.env.CC_WORKER_MODE || '').trim().toLowerCase();
  if (e) { if (!MODES.includes(e)) die('CC_WORKER_MODE must be one of: ' + MODES.join(', '), 64); return e; }
  try { const f = fs.readFileSync(MODE_FILE, 'utf8').trim().toLowerCase(); if (MODES.includes(f)) return f; } catch (_) {}
  return 'claude';
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
  if (!r || r === 'sonnet' || r === 'opus') return m.big; if (r === 'haiku') return m.fast; return req;
}
function logLaunch(provider, req) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) {}
    const headless = args.includes('-p') || args.includes('--print');
    fs.appendFileSync(LOG_FILE, [new Date().toISOString(), 'entry=' + entry, 'provider=' + provider, 'asked=' + (req || '-'),
      'model=' + effective(provider, req), headless ? 'headless' : 'interactive', 'cwd=' + process.cwd()].join(' ') + '\n');
  } catch (_) {}
}
const okModel = s => /^[A-Za-z0-9._:\[\]-]{2,64}$/.test(s || '');

// --- usage report: approximates how many tokens went to GLM/Z.ai instead of Anthropic,
// by scanning Claude Code's own local transcripts. Zero LLM calls. ---
const USAGE_HELP = 'usage: worker --usage [since] [--until <t>] [--json]   since: 24h | 30m | 8h | 2d | today | 2026-09-21 | 2026-09-21T18:00 (default 24h)';
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
  if (a0 === 'set') {
    const m = (args[1] || '').toLowerCase(); if (!MODES.includes(m)) die('usage: worker --set ' + MODES.join('|'), 64);
    fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true }); fs.writeFileSync(MODE_FILE, m + '\n'); console.log('worker mode = ' + m); return true;
  }
  if (a0 === 'level') {
    const n = args[1]; const name = MODES[Number(n)];
    if (!/^[0-3]$/.test(n || '') || !name) die('usage: worker --level 0|1|2|3   (0 claude, 1 light, 2 glm, 3 tight)', 64);
    fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true }); fs.writeFileSync(MODE_FILE, name + '\n');
    console.log('worker mode = ' + name + '   level L' + n + ' (' + name + ')'); return true;
  }
  if (a0 === 'set-model' || a0 === 'set-fast-model') {
    if (!okModel(args[1])) die('usage: worker --' + a0 + ' <model-id>   e.g. worker --' + a0 + ' glm-5.4', 64);
    const c = readConf(); c[a0 === 'set-model' ? 'glm_model' : 'glm_fast_model'] = args[1]; writeConf(c);
    console.log('glm_model = ' + c.glm_model + '   glm_fast_model = ' + c.glm_fast_model); return true;
  }
  if (a0 === 'usage') return cmdUsage(args.slice(1));
  if (a0 === 'log') {
    const n = parseInt(args[1], 10) || 10;
    try { console.log(fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-n).join('\n')); } catch (_) { console.log('(no launches logged yet)'); }
    return true;
  }
  if (a0 === 'status') {
    const m = models(), envMode = process.env.CC_WORKER_MODE;
    const md = readMode();
    console.log('level           L' + LEVEL_OF[md] + ' (' + md + ')' + (envMode ? '   (forced by CC_WORKER_MODE for this shell)' : ''));
    console.log('mode            ' + md);
    console.log('glm model       ' + m.big + (process.env.GLM_MODEL ? '   (forced by GLM_MODEL)' : ''));
    console.log('glm fast model  ' + m.fast + (process.env.GLM_FAST_MODEL ? '   (forced by GLM_FAST_MODEL)' : ''));
    console.log('ZAI_API_KEY     ' + (secret('ZAI_API_KEY') ? 'found' : 'MISSING'));
    console.log('claude binary   ' + claudeExe());
    console.log('router          v' + VERSION + '   ' + __filename);
    console.log('files           ' + MODE_FILE + ' | ' + CONF_FILE + ' | ' + LOG_FILE);
    return true;
  }
  if (a0 === 'router-help') {
    console.log('worker --status | --mode | --level 0|1|2|3 | --set claude|light|glm|tight | --set-model <id> | --set-fast-model <id> | --log [n] | --usage [since] [--json]\nanything else is passed to Claude Code unchanged, e.g.  worker -p "..." --model sonnet'); return true;
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

let provider;
if (entry === 'ccr') {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'code') { args = args.slice(1); provider = /^deepseek/i.test(modelArg(args)) ? 'deepseek' : 'glm'; }
  else if (['start', 'stop', 'restart', 'status', 'ui', 'serve', 'web', '-v', '--version', 'version'].includes(sub)) {
    console.log('ccr shim (cc-router v' + VERSION + '): no router service is needed; "ccr code" routes per process. Nothing to ' + (sub || 'do') + '.'); process.exit(0);
  } else die('this is the cc-router shim; only "ccr code [claude args]" is supported (got: ' + (sub || 'nothing') + ')', 64);
} else if (entry === 'glm') { provider = 'glm'; }
else { if (workerAdmin()) process.exit(0); provider = GLM_MODES.includes(readMode()) ? 'glm' : 'claude'; }

const env = Object.assign({}, process.env);
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDECODE$|CC_ROUTER_ENTRY$)/.test(k)) delete env[k];
const asked = modelArg(args);

if (provider === 'glm') {
  const key = secret('ZAI_API_KEY'); if (!key) die('ZAI_API_KEY not found (environment variable, or a line in ' + ENV_FILE + ').', 78);
  const m = models();
  Object.assign(env, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.big, ANTHROPIC_DEFAULT_SONNET_MODEL: m.big, ANTHROPIC_DEFAULT_HAIKU_MODEL: m.fast,
    CLAUDE_CODE_SUBAGENT_MODEL: m.big, API_TIMEOUT_MS: '3000000', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1' });   // GLM ids are not in Claude Code's model catalog; silences the yellow warning
  if (!asked) env.ANTHROPIC_MODEL = m.big;
} else if (provider === 'deepseek') {   // UNTESTED path: keeps old "ccr code --model deepseek-*" calls failing clearly or working
  const key = secret('DEEPSEEK_API_KEY'); if (!key) die('DEEPSEEK_API_KEY not found (environment variable, or a line in ' + ENV_FILE + ').', 78);
  const m = asked || 'deepseek-v4-pro';
  Object.assign(env, { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: m, API_TIMEOUT_MS: '3000000', ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  if (!asked) env.ANTHROPIC_MODEL = m;
}   // provider === 'claude': plain Claude Code on the subscription; env already scrubbed of ANTHROPIC_*

logLaunch(provider, asked);
const exe = claudeExe();
const child = spawn(exe, PREFIX.concat(args), { stdio: 'inherit', env });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch (_) {} });
child.on('error', e => die('cannot start ' + exe + ': ' + e.message, 127));
child.on('exit', (code, sig) => process.exit(sig ? 1 : (code === null ? 1 : code)));
