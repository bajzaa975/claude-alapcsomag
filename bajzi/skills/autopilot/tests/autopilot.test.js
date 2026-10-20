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
