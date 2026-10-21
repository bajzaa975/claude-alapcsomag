'use strict';
// An approved plan file is the night-run unit of work (text contract + a real dry run).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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
  assert.ok(B.includes('^\\**Status:\\**.*APPROVED') && B.includes('does not contain `BLOCKED`') && B.includes('at least one unchecked step (`- [ ]`)'));
  assert.ok(B.includes('PLAN: <repo-relative plan path> :: '));
});

test('run.sh prompt_for emits the plan instruction for a PLAN: note only', () => {
  const lib = path.join(__dirname, 'lib.sh');
  const run = path.join(DIR, 'run.sh');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pq-'));
  const sh = (p) => p.split(path.sep).join('/');
  const dry = (note) => {
    const nd = path.join(tmp, 'n' + Math.random().toString(36).slice(2));
    const script = `. '${sh(lib)}'; nr_make_night '${sh(nd)}'; printf 'P1|slug|-|%s\n' "$1" >'${sh(nd)}/queue.txt'; ` +
      `nr_config '${sh(nd)}/config.env' '${sh(nd)}' '${sh(nd)}' '${sh(nd)}/no-claude'; ` +
      `cd '${sh(tmp)}' && bash '${sh(run)}' --config '${sh(nd)}/config.env' --dry-run 2>&1`;
    return spawnSync('bash', ['-c', script, 'x', note], { encoding: 'utf8' }).stdout;
  };
  const plan = dry('PLAN: docs/plans/x.md :: it works');
  assert.match(plan, /Implement exactly the approved plan at docs\/plans\/x\.md\. Generate its slices/);
  assert.match(plan, /Story: P1 .*PLAN: docs\/plans\/x\.md :: it works/);
  assert.doesNotMatch(dry('plain criteria'), /approved plan at/);
});

test('BRIEF ticks the plan checkboxes; slice-format has the Plan -> slices rule', () => {
  assert.ok(flat(read('templates', 'BRIEF.md.tmpl')).includes("tick the plan's checkboxes"));
  const f = fs.readFileSync(path.join(DIR, '..', '..', '..', 'docs', 'slice-format.md'), 'utf8');
  assert.ok(f.includes('## Plan -> slices') && f.includes('`<plan-stem>-t<N>`') && f.includes('fits 64 chars'));
});
