'use strict';
// The plan critic's deterministic half: project size, critic model, critic-file parse/check, readiness.
// File format: header `key: value` lines, `## S<n> · <slice-id> · <high|medium|low>` scenarios (fields
// trigger / breaks / test), then `## Triage` (`auto: true`, `skipped: <reason>`, `S<n>: accept|reject`).
const fs = require('node:fs');
const path = require('node:path');

const SIZES = ['XS', 'S', 'M', 'L'];
const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const CONF = ['high', 'medium', 'low'];
const MAX_PER_SLICE = 3;
const MAX_TOTAL = 10;

function profile(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'project-profile.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function projectSize(cwd) {
  const p = profile(cwd);
  return p && SIZES.includes(p.size) ? p.size : null;
}
function criticModel(cwd) {
  const p = profile(cwd);
  if (!p || p.plan_critic_model === undefined) return 'fable';
  if (!MODELS.includes(p.plan_critic_model)) throw new Error(`plan_critic_model must be one of ${MODELS.join('|')}: ${JSON.stringify(p.plan_critic_model)}`);
  return p.plan_critic_model;
}

function parseCritic(text) {
  const header = {};
  const scenarios = [];
  let triage = null;
  let cur = null;
  const section = { kind: 'header' };
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^## (S\d+) · (\S+) · (\S+)\s*$/);
    if (h) { cur = { id: h[1], slice: h[2], confidence: h[3] }; scenarios.push(cur); section.kind = 'scenario'; continue; }
    if (/^## Triage\s*$/.test(line)) { triage = { auto: false, skipped: null, verdicts: {} }; section.kind = 'triage'; continue; }
    if (/^#{1,2} /.test(line) && section.kind === 'header') continue;
    const kv = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*?)\s*$/);
    if (!kv) continue;
    if (section.kind === 'header') header[kv[1]] = kv[2];
    else if (section.kind === 'scenario') { if (['trigger', 'breaks', 'test'].includes(kv[1]) && !(kv[1] in cur)) cur[kv[1]] = kv[2]; }
    else if (kv[1] === 'auto') triage.auto = kv[2] === 'true';
    else if (kv[1] === 'skipped') triage.skipped = kv[2];
    else if (/^S\d+$/.test(kv[1]) && (kv[2] === 'accept' || kv[2] === 'reject')) triage.verdicts[kv[1]] = kv[2];
  }
  return { header, scenarios, triage: triage || { auto: false, skipped: null, verdicts: {} }, hasTriage: triage !== null };
}

function criticCheck(text, sliceIds) {
  const errors = [];
  const { scenarios } = parseCritic(text);
  const per = {};
  const seen = new Set();
  for (const s of scenarios) {
    if (seen.has(s.id)) errors.push(`${s.id}: duplicate scenario id`);
    seen.add(s.id);
    if (!sliceIds.includes(s.slice)) errors.push(`${s.id}: unknown slice id ${s.slice}`);
    if (!CONF.includes(s.confidence)) errors.push(`${s.id}: confidence must be high|medium|low, got ${s.confidence}`);
    for (const f of ['trigger', 'breaks', 'test']) if (!s[f]) errors.push(`${s.id}: missing ${f}:`);
    per[s.slice] = (per[s.slice] || 0) + 1;
  }
  for (const [sl, n] of Object.entries(per)) if (n > MAX_PER_SLICE) errors.push(`${sl}: more than ${MAX_PER_SLICE} scenarios (${n})`);
  if (scenarios.length > MAX_TOTAL) errors.push(`more than ${MAX_TOTAL} scenarios in the plan (${scenarios.length})`);
  return errors;
}

function sliceIds(cwd, stem) {
  const re = new RegExp(`^(${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-t\\d+)\\.md$`);
  try { return fs.readdirSync(path.join(cwd, 'runtime', 'slices')).map((f) => (f.match(re) || [])[1]).filter(Boolean); } catch { return []; }
}

function criticReady(cwd, stem) {
  let text;
  try { text = fs.readFileSync(path.join(cwd, 'runtime', 'critic', `${stem}.md`), 'utf8'); } catch { return { ok: false, why: `no runtime/critic/${stem}.md` }; }
  const errors = criticCheck(text, sliceIds(cwd, stem));
  if (errors.length) return { ok: false, why: errors.join('; ') };
  const p = parseCritic(text);
  if (!p.hasTriage) return { ok: false, why: 'no ## Triage section' };
  if (p.triage.skipped !== null) return p.triage.skipped ? { ok: true, why: `skipped: ${p.triage.skipped}` } : { ok: false, why: 'skipped: has no reason' };
  const open = p.scenarios.filter((s) => !p.triage.verdicts[s.id]).map((s) => s.id);
  return open.length ? { ok: false, why: `triage missing for ${open.join(', ')}` } : { ok: true, why: 'triaged' };
}

module.exports = { projectSize, criticModel, parseCritic, criticCheck, criticReady, sliceIds };
