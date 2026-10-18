'use strict';
// Per-subagent effort values, effort on every routing line, pacing sentence placement.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const B = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(B, ...p), 'utf8');
const PACING = 'Time matters here: do not spend time that can be avoided, and the earlier a correct result is obtained, the better.';

test('agents carry the documented effort', () => {
  const want = { reviewer: 'high', implementer: 'medium', 'implementer-risk': 'high', fixer: 'medium' };
  for (const [a, e] of Object.entries(want)) {
    const fm = read('agents', `${a}.md`).split('---')[1];
    assert.match(fm, new RegExp(`^effort: ${e}$`, 'm'), a);
  }
});

test('every DAY-RUN-RULES routing line names an effort', () => {
  const t = read('skills', 'mode', 'DAY-RUN-RULES.md');
  const rows = t.split('ROUTING TABLE')[1].split('ESCALATION LADDER')[0].split('\n').filter(l => l.startsWith('- '));
  assert.ok(rows.length >= 8);
  for (const r of rows) {
    if (/^- design\/planning/.test(r)) continue; // ORCH main thread, no dispatch
    assert.match(r, /\b(low|medium|high|xhigh)\b/, r);
  }
  assert.match(t, /whole-branch review -> REVIEWER, xhigh/);
  assert.match(t, /`effort` parameter/);
});

test('pacing sentence in work briefs, not in review briefs', () => {
  const rules = read('skills', 'mode', 'DAY-RUN-RULES.md');
  const norm = s => s.replace(/\s+/g, ' ');
  assert.ok(norm(rules).includes(PACING));
  assert.ok(read('skills', 'mode', 'templates', 'dispatch-explore.md').includes(PACING));
  const d = read('skills', 'lib', 'dispatch.md');
  const fixer = d.split('## Fixer brief')[1];
  assert.ok(fixer.includes(PACING));
  assert.strictEqual(d.split(PACING).length, 2, 'only the fixer brief carries it in dispatch.md');
  assert.ok(!d.split('## Fixer brief')[0].includes(PACING));
  for (const f of fs.readdirSync(path.join(B, 'skills'))) {
    if (!/review|debug/.test(f)) continue;
    const dir = path.join(B, 'skills', f);
    for (const x of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, x);
      if (fs.statSync(p).isFile() && /\.md$/.test(p)) assert.ok(!fs.readFileSync(p, 'utf8').includes(PACING), p);
    }
  }
});

test('implement and fix briefs end with the pacing sentence; dispatch.md implement row names it', () => {
  for (const t of ['dispatch-implement.md', 'dispatch-fix.md']) {
    assert.ok(read('skills', 'mode', 'templates', t).trimEnd().endsWith(PACING), t);
  }
  const row = read('skills', 'lib', 'dispatch.md').split('\n').find(l => l.startsWith('| implement |'));
  assert.match(row, /pacing sentence/);
});

test('review brief sources do not carry the pacing sentence', () => {
  assert.ok(!read('skills', 'mode', 'templates', 'dispatch-review.md').includes(PACING));
  assert.ok(!read('lib', 'findings-cli.js').includes(PACING)); // the FC brief generator's template text
});

test('fix row: implementer model, medium, high for a risk-bearing slice', () => {
  const row = read('skills', 'mode', 'DAY-RUN-RULES.md').split('\n').find(l => l.startsWith('- fix review findings'));
  assert.match(row, /medium/);
  assert.match(row, /high.*risk|risk.*high/);
});

test('dispatch.md dispatch step names the effort parameter and xhigh final review', () => {
  const step = read('skills', 'lib', 'dispatch.md').split('2. **Dispatch**')[1].split('3. **Log**')[0];
  assert.match(step, /`effort`/);
  assert.match(step, /xhigh/);
});

test('spec agent contract names the optional effort key', () => {
  const s = fs.readFileSync(path.join(B, '..', 'docs', 'bajzi-package-spec.md'), 'utf8');
  const sec = s.split('### 6.12')[1].split('| Agent |')[0];
  assert.match(sec, /`effort`/);
  assert.doesNotMatch(sec, /no frontmatter\s+key outside `name`\/`description`\/`model`\/`tools`\)/);
});
