'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');

test('autopilot: owner-question format on BLOCKED entries and the review list', () => {
  assert.ok(SKILL.includes('-> recommended: <answer>'));
  assert.ok(SKILL.includes("LET'S REVIEW THIS TOGETHER"));
  assert.ok(SKILL.includes('all in ONE round'));
  assert.ok(SKILL.includes('`yes except <n>: <answer>` overrides single rows'));
});

test('autopilot: bookkeeping once per sprint, test gaps in the closing report', () => {
  assert.ok(SKILL.includes('ONE entry per sprint'));
  assert.ok(SKILL.includes('## Pending decisions'));
  assert.ok(SKILL.includes('after every slice commit'));
  assert.ok(!SKILL.includes('once at the end of each sprint'));
  assert.ok(SKILL.includes('runtime/findings/test-gaps.md'));
  assert.ok(!SKILL.includes('IMMEDIATELY'));
  assert.ok(!SKILL.includes('after every closed item'));
});

test('autopilot: decision-log instruction, no-node fallback, closing report path', () => {
  assert.ok(SKILL.includes("run `node <this skill's dir>/decision-log.js` once"));
  assert.ok(SKILL.includes('to the path it printed'));
  assert.ok(SKILL.includes('use `runtime/DECISIONS.md` only if `runtime/nightrun/.lock` does not exist, else `runtime/handoff/autopilot-decisions.md`'));
  assert.ok(SKILL.includes('referencing the decision log path'));
  assert.ok(!SKILL.includes('referencing DECISIONS.md'));
});

test('autopilot: rule 6 includes the sprint closing lines from review', () => {
  assert.ok(SKILL.includes("each sprint's closing lines when its review step printed them (the six time lines and the Tier 1 majors)"));
  assert.ok(!SKILL.includes('bajzi:review'));
});

test('autopilot: rule 2 never commits the untracked fallback decision log', () => {
  assert.ok(SKILL.includes('only written, never committed, when the printed path is `runtime/handoff/autopilot-decisions.md`'));
});
