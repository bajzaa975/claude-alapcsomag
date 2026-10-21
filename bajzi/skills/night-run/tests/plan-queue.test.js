'use strict';
// An approved plan file is the night-run unit of work (text contract + a real dry run).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');
const SKILL = flat(read('SKILL.md'));
const B = SKILL.slice(SKILL.indexOf('## PHASE B — Collect'), SKILL.indexOf('## PHASE C — Plan'));

test('PHASE B: approved plans come before BACKLOG.md, which is the legacy fallback', () => {
  const p = B.indexOf('2. Approved plans'), bl = B.indexOf('`docs/BACKLOG.md` (size');
  assert.ok(p >= 0 && bl > p);
  assert.ok(B.includes('legacy fallback') && B.includes('BACKLOG.md used as legacy fallback: convert its rows to approved plans'));
  assert.ok(B.includes('^\\**Status:\\**.*\\bAPPROVED\\b') && B.includes('neither `BLOCKED` nor `NOT APPROVED`') && B.includes('at least one unchecked step (`- [ ]`)'));
  assert.ok(B.includes('PLAN: <repo-relative plan path> :: '));
});

test('run.sh prompt_for emits the plan instruction for a PLAN: note only', (t) => {
  const lib = path.join(__dirname, 'lib.sh');
  const run = path.join(DIR, 'run.sh');
  const tmp = fs.mkdtempSync(path.join(process.env.NR_SCRATCH || os.tmpdir(), 'pq-'));
  const sh = (p) => p.split(path.sep).join('/');
  const dry = (note) => {
    const nd = path.join(tmp, 'n' + Math.random().toString(36).slice(2));
    const script = `. '${sh(lib)}'; nr_make_night '${sh(nd)}'; printf 'P1|slug|-|%s\n' "$1" >'${sh(nd)}/queue.txt'; ` +
      `nr_config '${sh(nd)}/config.env' '${sh(nd)}' '${sh(nd)}' '${sh(nd)}/no-claude'; ` +
      `cd '${sh(tmp)}' && bash '${sh(run)}' --config '${sh(nd)}/config.env' --dry-run 2>&1`;
    return spawnSync('bash', ['-c', script, 'x', note], { encoding: 'utf8' }).stdout;
  };
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const plan = dry('PLAN: docs/plans/x.md :: it works');
  assert.match(plan, /Implement exactly the approved plan at docs\/plans\/x\.md\. Generate its slices/);
  assert.match(plan, /Story: P1 .*PLAN: docs\/plans\/x\.md :: it works/);
  assert.match(plan, /run each through \/bajzi:implement, \/bajzi:review and \/bajzi:fix, and tick the plan's checkbox for each closed task/);
  assert.match(plan, /a needed scope change is PARKED with the question written down/);
  assert.doesNotMatch(dry('plain criteria'), /approved plan at/);
  assert.match(dry('PLAN: docs/plans/x.md :: '), /BLOCKED P1 .*no acceptance criteria/);
  assert.match(dry('PLAN: docs/plans/x.md'), /BLOCKED P1 .*no acceptance criteria/);
});

test('BRIEF ticks the plan checkboxes; slice-format has the Plan -> slices rule', () => {
  assert.ok(flat(read('templates', 'BRIEF.md.tmpl')).includes("tick the plan's checkboxes"));
  const f = fs.readFileSync(path.join(DIR, '..', '..', '..', 'docs', 'slice-format.md'), 'utf8');
  assert.ok(f.includes('## Plan -> slices') && f.includes('`<plan-stem>-t<N>`') && f.includes('fits 64 chars'));
});

test('no BACKLOG.md "primary source" claim; approval regex rejects NOT APPROVED / unapproved', () => {
  assert.ok(!SKILL.includes('is the primary source'));
  const rx = new RegExp(String.raw`^\**Status:\**.*\bAPPROVED\b`, 'i');
  assert.ok(SKILL.includes('`^\\**Status:\\**.*\\bAPPROVED\\b`') && SKILL.includes('neither `BLOCKED` nor `NOT APPROVED`'));
  const ok = (l) => rx.test(l) && !/BLOCKED|NOT APPROVED/i.test(l);
  assert.ok(ok('**Status:** APPROVED'));
  assert.ok(!ok('**Status:** NOT APPROVED') && !ok('Status: unapproved') && !ok('Status: APPROVED BLOCKED'));
});

test('BRIEF 3.3 names Plan -> slices and implement/review/fix', () => {
  const b = flat(read('templates', 'BRIEF.md.tmpl'));
  const s33 = b.slice(b.indexOf('### 3.3 Work'), b.indexOf('5. **One PR per story'));
  for (const w of ['Plan -> slices', '/bajzi:implement', '/bajzi:review', '/bajzi:fix', 'section 4 story-level review loop'])
    assert.ok(s33.includes(w), w);
});
