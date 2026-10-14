'use strict';
// Key-phrase test for the instruction-only /bajzi:which skill.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const text = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

test('frontmatter', () => {
  assert.ok(m, 'frontmatter present');
  const fm = m[1];
  assert.match(fm, /^name: which$/m);
  assert.match(fm, /^description:.*\/bajzi:which/m);
  assert.match(fm, /^argument-hint: /m);
  assert.doesNotMatch(fm, /disable-model-invocation/);
});

test('body key phrases', () => {
  for (const k of ['~/.claude/skill-catalog.json', 'at most 3', 'Never invent', 'no installed skill fits', 'catalog not found', 'Read-only']) {
    assert.ok(m[2].includes(k), `missing: ${k}`);
  }
});

test('body <= 45 lines', () => {
  const lines = m[2].replace(/^\n+/, '').replace(/\n+$/, '').split('\n').length;
  assert.ok(lines <= 45, `body has ${lines} lines`);
});

test('built-in examples list no plugin command (/code-review)', () => {
  const line = m[2].split('\n').find(l => l.includes('built-in slash commands'));
  assert.ok(line, 'built-in examples line present');
  assert.doesNotMatch(line, /\/code-review/);
});

test('manifest bajzi entry names every bajzi skill', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const mf = fs.readFileSync(path.join(root, 'skills', 'setup', 'manifest.json'), 'utf8');
  const why = mf.match(/"why": "own: ([^"]*)"/);
  assert.ok(why, 'bajzi own-skills entry present');
  const listed = why[1].split(' + ')[0].split(/[:/ ]/);
  for (const d of fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(root, 'skills', d.name, 'SKILL.md'))) {
      assert.ok(listed.includes(d.name), d.name);
    }
  }
});
