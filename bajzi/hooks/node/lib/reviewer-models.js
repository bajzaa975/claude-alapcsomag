'use strict';
// The reviewer allow-list (spec Invariant 3): `reviewer_models` in ~/.claude/bajzi/config.json, written by
// /bajzi:setup from manifest.json `bajzi_config`. BAJZI_HOME overrides the home dir (tests). ORDERED: entry
// [0] is the launch default wherever one id must be launched. Valid = a non-empty array whose EVERY entry
// is a claude- id; any other entry voids the WHOLE list (never filtered), so a GLM id can never review.
// The only validator on the bajzi side: day-run-mode.sh, setup/check.js and the night-run skill use it.
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

if (require.main === module) {
  const r = load();
  process.stdout.write((r.ok ? (process.argv.includes('--first') ? r.ids[0] : r.ids.join(', ')) : r.why) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}

module.exports = { load, configPath };
