'use strict';
// Claude Code statusLine command. Installed by /bajzi:setup to ~/.claude/bajzi/statusline.js
// (+ lib/). Line: model · Lx · branch* · task · ▓▓░░ NN% · GLM NN% · Qn · peak ...
// Missing data = that field is omitted; never an error text. Side effect: writes the ctx
// bridge <tmpdir>/bajzi-ctx-<session_id>.json that hooks/node/context-guard.js reads.
const os = require('node:os');
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
  const { level } = resolveLevel({ env, home });
  out.push('L' + level);
  const git = parts.gitInfo(cwd, nowMs);
  if (git) out.push(git.branch + (git.dirty ? '*' : ''));
  const task = parts.handoffTask(cwd);
  if (task) out.push(task);
  const used = usedPct(inp);
  if (used !== null) out.push(bar(used, color));
  if (level >= 1) {
    const g = parts.glmShare({ nowMs, home, env });
    if (g !== null) out.push(`GLM ${g}%`);
  }
  const q = parts.openQueueCount(cwd);
  if (q > 0) out.push('Q' + q);
  const pk = peakPart(nowMs);
  if (pk) out.push(pk);
  return out.join(SEP);
}

function main() {
  runHook('statusline', () => {
    loadLibs();
    const input = readInput() || {};
    const used = usedPct(input);
    if (used !== null) writeBridge(input.session_id, used, Date.now());
    writeAll(render(input) + '\n');
  });
}

if (require.main === module) main(); else loadLibs();

module.exports = { render, usedPct };
