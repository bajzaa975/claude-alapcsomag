'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rd = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

test('respec-cards: no owner-language default for question text or labels', () => {
  assert.doesNotMatch(rd('bajzi/skills/respec-cards/SKILL.md'), /in the owner's language/);
});

test('night-run: story prompt and brief share context thresholds', () => {
  const run = rd('bajzi/skills/night-run/run.sh');
  const brief = rd('bajzi/skills/night-run/templates/BRIEF.md.tmpl');
  assert.match(run, /at 40% of it stop taking new scope, at 50% finalize/);
  assert.match(brief, /at roughly 40%\*\*: stop taking new scope/);
  assert.match(brief, /at roughly 50%\*\*, or at the FINALIZE/);
});
