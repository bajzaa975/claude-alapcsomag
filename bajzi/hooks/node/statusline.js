'use strict';
// Claude Code statusLine command. Installed by /bajzi:setup to ~/.claude/bajzi/statusline.js
// (+ lib/). Line: model · Lx · branch* · task · ▓▓░░ NN% · 5h NN% · 7d NN% · GLM NN% · Qn · peak ...
// Missing data = that field is omitted; never an error text. Side effects: writes the ctx
// bridge <tmpdir>/bajzi-ctx-<session_id>.json that hooks/node/context-guard.js reads, and AFTER the
// line is out, <status dir>/<session_id>.line.json for the workbench (spec §6.5, writeLine).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInput, runHook, writeAll } = require('./lib/hook-io');
// Libs other than hook-io load inside runHook (F4): a partial install still fails open.
let resolveLevel, writeBridge, peakStatus, parts;
function loadLibs() {
  ({ resolveLevel } = require('./lib/saver-level'));
  ({ writeBridge } = require('./lib/bridge'));
  ({ peakStatus } = require('./lib/peak'));
  parts = require('./lib/status-parts');
}

const SEP = ' \u00b7 ';
const C = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
const LINE_EVERY_S = 30;

function usedPct(input) {
  const cw = input && typeof input.context_window === 'object' && input.context_window ? input.context_window : null;
  const rem = cw ? cw.remaining_percentage : undefined;
  if (typeof rem !== 'number' || !Number.isFinite(rem)) return null;
  return Math.min(100, Math.max(0, Math.round(100 - rem)));
}

function bar(used, color) {
  const filled = Math.round(used / 10);
  const text = '\u2593'.repeat(filled) + '\u2591'.repeat(10 - filled) + ' ' + used + '%';
  if (!color) return text;
  const c = used >= 50 ? C.red : used >= 40 ? C.yellow : C.green;
  return c + text + C.reset;
}

function fmtMins(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

function peakPart(nowMs) {
  const p = peakStatus(nowMs);
  if (p.inPeak) return `peak now, ${fmtMins(p.minsToEnd)} left`;
  if (p.minsToStart !== null && p.minsToStart <= 120) return `peak in ${fmtMins(p.minsToStart)}`;
  return null;
}

function cwdOf(input) {
  const ws = input && typeof input.workspace === 'object' && input.workspace ? input.workspace : {};
  if (typeof ws.current_dir === 'string' && ws.current_dir) return ws.current_dir;
  if (input && typeof input.cwd === 'string' && input.cwd) return input.cwd;
  return process.cwd();
}

function render(input, opts = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const nowMs = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const color = opts.color === undefined ? !env.NO_COLOR : opts.color;
  const cwd = cwdOf(inp);
  const out = [];
  const model = inp.model && typeof inp.model.display_name === 'string' ? inp.model.display_name.trim() : '';
  if (model) out.push(model);
  const { level } = resolveLevel({ env, home, sessionId: inp.session_id });   // this session's level, spec §6.1
  out.push('L' + level);
  const git = parts.gitInfo(cwd, nowMs);
  if (git) out.push(git.branch + (git.dirty ? '*' : ''));
  const task = parts.handoffTask(cwd);
  if (task) out.push(task);
  const used = usedPct(inp);
  if (used !== null) out.push(bar(used, color));
  const lim = obj(inp.rate_limits);
  const h5 = numOr(obj(lim.five_hour).used_percentage);
  if (h5 !== undefined) out.push(`5h ${Math.round(h5)}%`);
  const d7 = numOr(obj(lim.seven_day).used_percentage);
  if (d7 !== undefined) out.push(`7d ${Math.round(d7)}%`);
  let g = null;
  if (level >= 1) {
    g = parts.glmShare({ nowMs, home, env });
    if (g !== null) out.push(`GLM ${g}%`);
  }
  const q = parts.openQueueCount(cwd);
  if (q > 0) out.push('Q' + q);
  const pk = peakPart(nowMs);
  if (pk) out.push(pk);
  if (opts.facts) Object.assign(opts.facts, { level, branch: git ? git.branch : undefined, glm: g === null ? undefined : g });
  return out.join(SEP);
}

const obj = v => (v && typeof v === 'object' ? v : {});
const strOr = v => (typeof v === 'string' && v ? v : undefined);
const numOr = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// <status dir>/<session_id>.line.json (the status record contract, spec §6.5). Missing data = the
// key is omitted. Written only when the content changed or LINE_EVERY_S passed since the file's own
// ts (or the clock went back). `facts` = what render() computed: {level, branch, glm}.
function writeLine(input, facts, nowMs, env = process.env) {
  const ss = require('./lib/session-status');
  const inp = obj(input);
  if (typeof inp.session_id !== 'string' || !ss.SAFE_ID.test(inp.session_id)) return false;
  const ws = obj(inp.workspace);
  const model = obj(inp.model).display_name;
  const rec = {
    v: 1, session_id: inp.session_id, session_name: strOr(inp.session_name), cwd: cwdOf(inp),
    project_dir: strOr(ws.project_dir), git_worktree: strOr(ws.git_worktree), branch: facts.branch,
    model: typeof model === 'string' ? strOr(model.trim()) : undefined,
    ctx_pct: numOr(obj(inp.context_window).used_percentage), cost_usd: numOr(obj(inp.cost).total_cost_usd),
    five_hour_pct: numOr(obj(obj(inp.rate_limits).five_hour).used_percentage),
    seven_day_pct: numOr(obj(obj(inp.rate_limits).seven_day).used_percentage),
    glm_share: facts.glm, bajzi_level: 'L' + facts.level,
  };
  const dir = ss.statusDir(env);
  const name = `${inp.session_id}.line.json`;
  const ts = Math.floor(nowMs / 1000);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { prev = null; }
  if (prev && typeof prev.ts === 'number' && ts >= prev.ts && ts - prev.ts < LINE_EVERY_S
    && JSON.stringify(Object.assign({}, rec, { ts: prev.ts })) === JSON.stringify(prev)) return false;
  return ss.writeJson(dir, name, Object.assign({}, rec, { ts }));
}

function main() {
  runHook('statusline', () => {
    loadLibs();
    const input = readInput() || {};
    const used = usedPct(input);
    if (used !== null) writeBridge(input.session_id, used, Date.now());
    const facts = {};
    writeAll(render(input, { facts }) + '\n');
    // After the line is out: a missing lib or a failed write never costs the status line.
    writeLine(input, facts, Date.now());
  });
}

if (require.main === module) main(); else loadLibs();

module.exports = { render, usedPct, writeLine };
