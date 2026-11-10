'use strict';
// Sprint ledger: `FC ledger <stem>` | `escaped <stem> "<text>"` | `report`. One JSON object per line in
// runtime/ledger.jsonl (append-only, except that a stem's sprint line is replaced when sent again).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const F = require('./findings');
const C = require('./critic');
const U = require('./usage');
const PRICES = require('./prices.json');

const LEDGER = 'runtime/ledger.jsonl';
const SEV = ['major', 'blocker'];
const PHASES = [['critic', /critic/], ['build', /implementer/], ['review', /review/], ['fix', /fix/]];
const phaseOf = (type) => (type === 'main' ? 'plan' : (PHASES.find(([, re]) => re.test(type)) || ['other'])[0]);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function readLedger(cwd) {
  // A line that does not parse refuses: writeLedger rewrites the whole file, so dropping it would delete it.
  return read(path.join(cwd, LEDGER)).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${LEDGER} line ${i + 1} is not valid JSON; fix or remove it, nothing was written`); }
  });
}
function writeLedger(cwd, rows) {
  fs.mkdirSync(path.join(cwd, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(cwd, LEDGER), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function findingsOf(cwd, id, round) {
  const t = read(path.join(cwd, 'runtime', 'findings', `${id}-r${round}.md`));
  return t ? F.parse(t).findings : null;
}

// A slice without its own findings files falls back to the sprint's stem-named files; sprint.owner (the first such
// slice) alone counts their findings, so a sprint review is not counted once per slice.
function sliceRow(cwd, id, sprint) {
  let r1 = findingsOf(cwd, id, 1);
  let r2 = findingsOf(cwd, id, 2);
  let count = true;
  if (!r1 && !r2 && sprint) { r1 = sprint.r1; r2 = sprint.r2; count = sprint.owner === id; }
  const big = (fs_) => (count ? fs_ || [] : []).filter((f) => SEV.includes(f.severity));
  const r1ids = new Set((r1 || []).map((f) => f.id));
  const row = { id, r1: { lifecycle: 0, other: 0 }, r2_new_majors: 0, open_after_r2: 0, rounds: (r1 ? 1 : 0) + (r2 ? 1 : 0) };
  for (const f of big(r1)) row.r1[f.class === 'lifecycle' ? 'lifecycle' : 'other']++;
  row.r2_new_majors = big(r2).filter((f) => !r1ids.has(f.id)).length;
  row.open_after_r2 = big(r2).filter((f) => f.status === 'open').length;
  row.critics = (count ? [...(r1 || []), ...(r2 || [])] : []).map((f) => f.critic).filter(Boolean);
  return row;
}

function criticRow(cwd, stem, slices) {
  const text = read(path.join(cwd, 'runtime', 'critic', `${stem}.md`));
  if (!text) return { raised: 0, accepted: 0, matched: 0, skipped: false };
  const p = C.parseCritic(text);
  const ids = new Set(p.scenarios.map((s) => s.id));
  const matched = new Set(slices.flatMap((s) => s.critics).filter((c) => ids.has(c)));
  return {
    raised: p.scenarios.length,
    accepted: Object.values(p.triage.verdicts).filter((v) => v === 'accept').length,
    matched: matched.size,
    skipped: p.triage.skipped !== null,
  };
}

function usd(model, r) {
  const m = PRICES.models[String(model).replace(/-\d{8}$/, '')];
  if (!m) return null;
  return (r.in * m.input + r.out * m.output + r.cr * m.input * m.cache_read_mult + r.cw * m.input * m.cache_write_mult) / 1e6;
}
// Sum over models; null when any model has no price (never a guessed figure).
function sumUsd(models) {
  let t = 0;
  for (const [model, r] of models) { const c = usd(model, r); if (c === null) return null; t += c; }
  return round6(t);
}

// ponytail: 5-minute cache-write price only; 1-hour writes are costed as 5-minute (upgrade: read usage.cache_creation).
async function sprintUsage(cwd, since, until) {
  const dir = process.env.BAJZI_TRANSCRIPTS || path.join(os.homedir(), '.claude', 'projects');
  const files = U.transcripts(dir, since);
  const byType = new Map(); // agent type | main -> Map model -> usage
  const ids = new Set();
  for (const f of files) {
    let type = 'main';
    if (path.basename(path.dirname(f)) === 'subagents') {
      type = 'subagent';
      try { type = JSON.parse(read(f.replace(/\.jsonl$/, '.meta.json'))).agentType || type; } catch { /* no meta: generic subagent */ }
    }
    try {
      await U.eachLine(f, (l) => {
        let o; try { o = JSON.parse(l); } catch { return; }
        const ts = Date.parse(o && o.timestamp);
        if (!o || o.type !== 'assistant' || !o.message || o.cwd !== cwd || !(ts >= since && ts <= until)) return;
        if (!byType.has(type)) byType.set(type, new Map());
        U.addUsage(byType.get(type), ids, o.message, o.message.model || '(none)');
      });
    } catch { /* unreadable transcript: skipped */ }
  }
  const agents = {};
  const phaseModels = new Map();
  for (const [type, models] of byType) {
    agents[type] = { usd: sumUsd(models) };
    const ph = phaseOf(type);
    if (!phaseModels.has(ph)) phaseModels.set(ph, new Map());
    for (const [m, r] of models) {
      const t = phaseModels.get(ph).get(m) || { in: 0, out: 0, cr: 0, cw: 0 };
      for (const k of Object.keys(t)) t[k] += r[k];
      phaseModels.get(ph).set(m, t);
    }
  }
  const phases = {};
  for (const [ph] of [['plan'], ...PHASES, ['other']]) phases[ph] = { usd: sumUsd(phaseModels.get(ph) || new Map()) };
  phases.plan.approx = true; // the main session may share the repo and window with other work
  return { files: files.length, agents, phases };
}

// The critic file's `started:` time when valid, else the earliest of the plan file and the critic file mtimes; always with
// the oldest implement commit. Without `started:` and when neither file exists, the committer time of that commit's
// parent. null when there is no implement commit.
function windowStart(cwd, stem) {
  try {
    const git = (a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = git(['log', '--format=%ct %P', '-E', `--grep=^${stem}-t[0-9]+: implement`]).split('\n').filter(Boolean).map((l) => l.split(' '));
    if (!rows.length) return null;
    const [ct, parent] = rows.reduce((a, b) => (Number(b[0]) < Number(a[0]) ? b : a));
    const times = [Number(ct) * 1000];
    let found = false;
    const started = C.parseCritic(read(path.join(cwd, 'runtime', 'critic', `${stem}.md`))).header.started;
    if (started) return Math.min(...times, Date.parse(started));
    for (const f of [`runtime/plans/${stem}.md`, `docs/superpowers/plans/${stem}.md`, `runtime/critic/${stem}.md`]) {
      try { times.push(fs.statSync(path.join(cwd, f)).mtimeMs); found = true; } catch { /* absent */ }
    }
    if (!found && parent) times.push(Number(git(['log', '-1', '--format=%ct', parent]).trim()) * 1000);
    return Math.min(...times);
  } catch { return null; }
}

async function sendSprint(cwd, stem) {
  const ids = C.sliceIds(cwd, stem).sort((a, b) => Number(a.split('-t').pop()) - Number(b.split('-t').pop()));
  const own = (id) => findingsOf(cwd, id, 1) || findingsOf(cwd, id, 2);
  const sprint = { r1: findingsOf(cwd, stem, 1), r2: findingsOf(cwd, stem, 2), owner: ids.find((id) => !own(id)) };
  const slices = ids.map((id) => sliceRow(cwd, id, sprint));
  const critic = criticRow(cwd, stem, slices);
  slices.forEach((s) => delete s.critics);
  const since = windowStart(cwd, stem);
  const now = Date.now();
  const notes = [];
  if (since === null) notes.push(`no ${stem}-t<N>: implement commit`);
  const u = since === null ? { files: 0, agents: {}, phases: {} } : await sprintUsage(cwd, since, now);
  if (since !== null && u.files === 0) notes.push('no transcripts');
  if (since === null) for (const p of ['plan', 'critic', 'build', 'review', 'fix', 'other']) u.phases[p] = { usd: 0 };
  if (u.phases.plan) u.phases.plan.approx = true;
  const row = { type: 'sprint', stem, ts: new Date(now).toISOString(), slices, critic, cost: { agents: u.agents, phases: u.phases }, note: notes.join('; ') };
  writeLedger(cwd, [...readLedger(cwd).filter((r) => !(r.type === 'sprint' && r.stem === stem)), row]);
  return `ledger: ${stem} · ${slices.length} slices${row.note ? ` · ${row.note}` : ''}\n`;
}

function baselineFor(cwd) {
  let base;
  try {
    const cfg = JSON.parse(read(path.join(os.homedir(), '.claude', 'bajzi', 'config.json')).replace(/^﻿/, ''));
    base = JSON.parse(read(cfg.ledger_baselines).replace(/^﻿/, ''));
  } catch { return null; }
  const b = base[path.basename(cwd)] || base.default;
  return b && Number.isFinite(b.rounds_per_slice) && Number.isFinite(b.round_cost_usd) ? b : null;
}

const money = (v, approx) => (v === null ? 'n/a' : `$${v.toFixed(2)}${approx ? ' approx' : ''}`);
const avg = (n, d) => (d ? Math.round((n / d) * 100) / 100 : 0);

function report(cwd) {
  const rows = readLedger(cwd);
  const out = [];
  const sprints = rows.filter((r) => r.type === 'sprint');
  if (!sprints.length) out.push('ledger: no sprints');
  let rounds = 0; let count = 0;
  for (const s of sprints) {
    const n = s.slices.length;
    const sum = (f) => s.slices.reduce((t, x) => t + f(x), 0);
    const lc = sum((x) => x.r1.lifecycle); const ot = sum((x) => x.r1.other);
    rounds += sum((x) => x.rounds); count += n;
    const c = s.critic;
    const ph = s.cost.phases;
    const total = Object.values(ph).some((p) => p.usd === null) ? null : round6(Object.values(ph).reduce((t, p) => t + p.usd, 0));
    out.push(`sprint ${s.stem} · ${String(s.ts).slice(0, 10)} · ${n} slices`,
      `  r1 majors/slice: ${avg(lc + ot, n)} (lifecycle ${lc}, other ${ot})`,
      `  rounds/slice: ${avg(sum((x) => x.rounds), n)}`,
      `  fix-introduced majors: ${sum((x) => x.r2_new_majors)}`,
      `  open after r2: ${sum((x) => x.open_after_r2)}`,
      `  critic: raised ${c.raised} · accepted ${c.accepted} · matched ${c.matched} · skipped ${c.skipped ? 'yes' : 'no'}`,
      `  cost: ${['plan', 'critic', 'build', 'review', 'fix'].map((p) => `${p} ${money(ph[p] ? ph[p].usd : 0, ph[p] && ph[p].approx)}`).join(' · ')} · total ${money(total)}`,
      `  escaped: ${rows.filter((r) => r.type === 'escaped' && r.stem === s.stem).length}${s.note ? `  (${s.note})` : ''}`);
  }
  const b = baselineFor(cwd);
  if (!b || !count) out.push('savings: n/a');
  else {
    out.push(`savings (estimate): ${money(round6((b.rounds_per_slice - rounds / count) * count * b.round_cost_usd))} ` +
      `(baseline rounds/slice ${b.rounds_per_slice}, actual ${avg(rounds, count)}, ${count} slices, $${b.round_cost_usd}/round)`);
  }
  return out.join('\n') + '\n';
}

async function run(cwd, args) {
  const [a, ...rest] = args;
  if (a === 'report') return report(cwd);
  if (a === 'escaped') {
    const [stem, text] = rest;
    if (!stem || !text) throw new Error('usage: ledger escaped <stem> "<text>"');
    writeLedger(cwd, [...readLedger(cwd), { type: 'escaped', stem, text, ts: new Date().toISOString() }]);
    return `ledger: escaped bug recorded for ${stem}\n`;
  }
  if (!a) throw new Error('usage: ledger <stem> | escaped <stem> "<text>" | report');
  return sendSprint(cwd, a);
}

module.exports = { run };
