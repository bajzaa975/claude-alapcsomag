'use strict';
// Public-tree rules: no Hungarian accented letters, no citations of the deleted plan.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter((f) => f && fs.existsSync(path.join(root, f)));
const accent = new RegExp('[\u00e1\u00e9\u00ed\u00f3\u00f6\u0151\u00fa\u00fc\u0171\u00c1\u00c9\u00cd\u00d3\u00d6\u0150\u00da\u00dc\u0170]');
const plan = new RegExp(['plan ' + '\u00a7', 'agents-and' + '-cadence'].join('|'));

function offenders(re) {
  return files.filter((f) => {
    const buf = fs.readFileSync(path.join(root, f));
    return !buf.includes(0) && re.test(buf.toString('utf8'));
  });
}

test('no tracked file contains a Hungarian accented letter', () => {
  assert.deepStrictEqual(offenders(accent), []);
});

test('no tracked file cites the deleted plan', () => {
  assert.deepStrictEqual(offenders(plan), []);
});
