'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');

test('review: sprint-end step runs the gate once, in the background', () => {
  for (const s of ['ONCE per sprint', 'run_in_background', 'never both', 'tier-1 r1 majors', 'FC gaps',
    'code: <n> min', 'bookkeeping: <n> min', 'review: <n> min', 'fix: <n> min', 'tests: <n> min', 'gate: <n> min']) {
    assert.ok(SKILL.includes(s), s);
  }
});

test('review: round-1 CLEAN points to the sprint-end step', () => {
  assert.ok(SKILL.includes('`CLEAN` -> step 7'));
  assert.ok(!SKILL.includes('`CLEAN` -> done'));
});
