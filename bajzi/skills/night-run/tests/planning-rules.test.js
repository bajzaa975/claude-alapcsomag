'use strict';
// nr-planning-rules: the owner's 2026-10-03 innotel-bss lessons. Restrictions are asked ONCE, in one
// table, before the queue is drafted, and never deferred silently; advisor-gated items are built with
// the spec default as config; auth is ordinary night work unless the project's NIGHT-RULES say so;
// the deadline may span several days, chosen at the gate, with WATCH_MAX_RESTARTS scaled to it and
// the weekly-quota risk stated once. Phrase assertions on flattened text, no whole-file snapshot.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');
const SKILL = flat(read('SKILL.md'));
const BRIEF = flat(read('templates', 'BRIEF.md.tmpl'));
const CONFIG = flat(read('templates', 'config.env.tmpl'));
const RULES = flat(read('templates', 'NIGHT-RULES.md.tmpl'));
const has = (hay, phrase) => assert.ok(hay.includes(phrase), `missing: ${phrase}`);
const slice = (hay, from, to) => {
  const a = hay.indexOf(from), b = hay.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} .. ${to} present in order`);
  return hay.slice(a, b);
};
const count = (hay, phrase) => hay.split(phrase).length - 1;
const FORMULA = 'max(2, ceil(run_hours / 12))';
const QUOTA_RISK = 'a multi-day run can exhaust the weekly Claude quota';

test('PHASE B: restrictions are asked ONCE in ONE table, before the queue is drafted', () => {
  const b = slice(SKILL, '## PHASE B — Collect', '## PHASE C — Plan');
  has(b, '**Restrictions are asked ONCE, at the start of planning, before the queue is drafted.**');
  has(b, 'Before you defer or drop ANY candidate story because of a NIGHT-RULES restriction or a pending outside answer (advisor, accountant, lawyer, owner)');
  has(b, 'list every such story in ONE table and ask the owner ONCE');
  has(b, '| story | restriction | source line | recommendation |');
  has(b, '`build`, `build with the spec default as config` or `defer`');
  has(b, 'never one question per story, never a second round');
  has(b, 'This rule supersedes the design spec\'s PHASE B "subtract" line and its PHASE D "only question" line');
  assert.ok(!b.includes('Then SUBTRACT everything'), 'the silent NIGHT-RULES subtraction is gone');
  // the table comes before PHASE C drafts the queue
  assert.ok(SKILL.indexOf('| story | restriction | source line | recommendation |') < SKILL.indexOf('## PHASE C — Plan'));
});

test('PHASE B: no fait-accompli parked/external lists; advisor-gated items are built with the default as config', () => {
  const b = slice(SKILL, '## PHASE B — Collect', '## PHASE C — Plan');
  has(b, 'A "parked for owner" or "waiting on external answer" list never appears in the plan, the gate or the brief as a fait accompli.');
  has(b, '**Items gated only by an advisor\'s confirmation are BUILT**, with the card/spec default as a config value the advisor can change later');
  has(b, 'The owner\'s answer per row is RECORDED');
  has(b, 'Auth-touching stories are ordinary night work');
  has(b, 'no plugin rule restricts them');
});

test('PHASE C: deferral only with the owner\'s recorded answer', () => {
  const c = slice(SKILL, '## PHASE C — Plan', '## PHASE D — Approval gate');
  has(c, 'never defer one for a NIGHT-RULES restriction or a pending outside answer the owner was not asked about');
});

test('PHASE D: refuses a deferral without the owner\'s recorded answer; two questions total', () => {
  const d = slice(SKILL, '## PHASE D — Approval gate', '## PHASE E — Launch');
  has(d, 'The gate REFUSES a plan that defers a story for a NIGHT-RULES restriction or a pending outside answer without the owner\'s recorded answer');
  has(d, '`UNASKED DEFERRAL: <story> — <restriction>`');
  has(d, 'apart from the PHASE B restriction table');
  assert.ok(!SKILL.includes('it is the ONLY question this skill asks'), 'the gate is no longer the only question');
});

test('deadline: no 07:30 cap; multi-day choice at the gate, local and UTC', () => {
  assert.ok(!SKILL.includes('07:30'), 'no 07:30 cap remains');
  assert.ok(!/capped at \d/.test(SKILL), 'no deadline cap remains');
  const d = slice(SKILL, '## PHASE D — Approval gate', '## PHASE E — Launch');
  has(d, 'the owner chooses here between a one-night queue');
  has(d, 'a multi-day deadline');
  has(d, 'absolute date+time in the run machine\'s local zone AND in UTC');
  has(d, `date -u -d "<deadline>" '+%F %H:%M UTC'`);
  has(d, 'the plan\'s total estimate');
  has(SKILL, 'as an absolute `YYYY-MM-DD HH:MM`');
  has(d, 'Any change at the gate to the deadline or to the queue goes back to PHASE C');
  assert.ok(!d.includes('re-render `launch.sh`, `WATCHER-BRIEF.md`'), 'no hand-picked partial re-render list');
});

test('WATCH_MAX_RESTARTS scales with the run length, in SKILL.md and config.env.tmpl', () => {
  has(SKILL, FORMULA);
  has(SKILL, 'replacing an existing uncommented `WATCH_MAX_RESTARTS=` line, never adding a second');
  has(CONFIG, FORMULA);
  has(CONFIG, 'run_hours');
  has(CONFIG, 'as an uncommented line, replacing an earlier uncommented one, never a second');
});

test('weekly-quota risk is stated ONCE, as a risk, never as a number', () => {
  assert.strictEqual(count(SKILL, QUOTA_RISK), 1, 'quota risk sentence exactly once');
  has(SKILL, 'the runner waits out a session-limit reset, but a weekly-limit hit ends the run');
  has(SKILL, 'never as a guessed number');
});

test('BRIEF.md.tmpl §5: auth-touching diffs follow the project NIGHT-RULES; no plugin blocker', () => {
  const s5 = slice(BRIEF, '## 5. Merge gate', '## 6. Project rules');
  has(s5, 'Auth-touching diffs follow the project\'s NIGHT-RULES (sections 2 and 6) like any other change; no plugin rule makes them a blocker.');
  assert.ok(!BRIEF.includes('{{AUTH'), 'no new placeholder');
});

test('NIGHT-RULES.md.tmpl §2 no longer seeds an owner-decision deferral', () => {
  const s2 = slice(RULES, '## 2. Forbidden stories', '## 3. Forbidden paths');
  assert.ok(!s2.includes('needs a decision only the owner can take'));
  has(s2, 'asked ONCE at planning');
});
