'use strict';
// The reviewer allow-list (spec Invariant 3): `reviewer_models` in ~/.claude/bajzi/config.json, written by
// /bajzi:setup from manifest.json `bajzi_config`. BAJZI_HOME overrides the home dir (tests). ORDERED: entry
// [0] is the launch default wherever one id must be launched. Valid = a non-empty array whose EVERY entry
// is a claude- id; any other entry voids the WHOLE list (never filtered), so a GLM id can never review.
// The only validator on the bajzi side: day-run-mode.sh, routing-counter.sh (--off-list-served),
// setup/check.js and the night-run skill use it.
// CLI: prints the ids comma-joined (--first: entry [0] only), exit 0; invalid: prints why, exit 1.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID = /^claude-[A-Za-z0-9._-]+$/;

function configPath(home) {
  return path.join(home, '.claude', 'bajzi', 'config.json');
}

function load(home = process.env.BAJZI_HOME || os.homedir()) {
  const p = configPath(home);
  let v;
  try {
    v = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, why: e && e.code === 'ENOENT' ? `${p} missing` : `${p} is not valid JSON` };
  }
  const ids = v !== null && typeof v === 'object' && !Array.isArray(v) ? v.reviewer_models : undefined;
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, why: 'reviewer_models is missing or empty' };
  const i = ids.findIndex(x => typeof x !== 'string' || !ID.test(x));
  if (i >= 0) return { ok: false, why: `reviewer_models[${i}] ${JSON.stringify(ids[i]).slice(0, 40)} is not a claude- model id` };
  return { ok: true, ids };
}

// The SERVED models of one finished Agent dispatch (a PostToolUse payload) that are not on the list, for
// routing-counter.sh's reviewer check. Served = the assistant `message.model` ids of the sub-agent's own
// transcript, <transcript_path minus .jsonl>/subagents/agent-<tool_response.agentId>.jsonl (`<synthetic>`
// skipped); none found (async launch, older CLI) -> tool_response.resolvedModel. An invalid list has no
// members, so everything served is off it. Ids come back log-safe: lowercase [a-z0-9._-], <= 64 chars.
function offListServed(payload, home) {
  const r = load(home);
  const p = payload !== null && typeof payload === 'object' ? payload : {};
  const tr = p.tool_response !== null && typeof p.tool_response === 'object' ? p.tool_response : {};
  const served = new Set();
  const id = typeof tr.agentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tr.agentId) ? tr.agentId : '';
  const tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (id && tp.endsWith('.jsonl')) {
    let text = '';
    try { text = fs.readFileSync(path.join(tp.slice(0, -6), 'subagents', `agent-${id}.jsonl`), 'utf8'); } catch { /* none */ }
    for (const line of text.split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e && e.type === 'assistant' && e.message && e.message.model;
      if (typeof m === 'string' && m && m !== '<synthetic>') served.add(m);
    }
  }
  if (!served.size && typeof tr.resolvedModel === 'string' && tr.resolvedModel) served.add(tr.resolvedModel);
  const safe = [...served].map(m => m.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64)).filter(Boolean);
  return [...new Set(safe)].filter(m => !(r.ok && r.ids.includes(m)));
}

if (require.main === module) {
  if (process.argv.includes('--off-list-served')) {
    // stdin = the PostToolUse payload; one '<off-list served id> <cause>' per line, cause = off-list (a valid
    // list without it) or no-allowlist (the list is missing/invalid: a config error); always exit 0.
    let s = '';
    process.stdin.on('data', d => { s += d; }).on('end', () => {
      let v = null;
      try { v = JSON.parse(s); } catch { /* nothing to judge */ }
      const ids = v ? offListServed(v) : [];
      const cause = load().ok ? 'off-list' : 'no-allowlist';
      if (ids.length) process.stdout.write(ids.map(m => `${m} ${cause}`).join('\n') + '\n');
    });
  } else {
    const r = load();
    process.stdout.write((r.ok ? (process.argv.includes('--first') ? r.ids[0] : r.ids.join(', ')) : r.why) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  }
}

module.exports = { load, configPath, offListServed };
