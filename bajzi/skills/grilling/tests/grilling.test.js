'use strict';
// Key-phrase test for the interview skills: grilling, grill-me, respec-cards.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const skills = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(skills, p), 'utf8').replace(/\r\n/g, '\n');
const split = p => read(p).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

test('frontmatter', () => {
  for (const [n, off] of [['grilling', false], ['grill-me', true], ['respec-cards', true]]) {
    const m = split(`${n}/SKILL.md`);
    assert.ok(m, `${n} frontmatter`);
    assert.match(m[1], new RegExp(`^name: ${n}$`, 'm'));
    assert.strictEqual(/^disable-model-invocation:/m.test(m[1]), off, `${n} disable-model-invocation`);
  }
  assert.match(split('grill-me/SKILL.md')[1], /^argument-hint: /m);
});

test('body key phrases', () => {
  assert.ok(split('grill-me/SKILL.md')[2].includes('bajzi:grilling'));
  for (const k of ['Grilled: grilling <YYYY-MM-DD> (Q1-Qn)', '**Proof:**', '## Decisions', 'runtime/handoff/'])
    assert.ok(split('grilling/SKILL.md')[2].includes(k), `grilling missing: ${k}`);
  for (const k of ['Grilled: respec-cards <YYYY-MM-DD> (cards NN-MM)', 'NEVER RE-ASK', '**Proof:**', 'answers-NN.md'])
    assert.ok(split('respec-cards/SKILL.md')[2].includes(k), `respec-cards missing: ${k}`);
});

test('support files', () => {
  assert.ok(fs.existsSync(path.join(skills, 'respec-cards', 'prep-prompt.md')));
  const n = read('grilling/NOTICE.md');
  assert.ok(n.includes('MIT License') && n.includes('mattpocock/skills'));
});

test('no absolute paths, no openai.yaml', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const s of ['grilling', 'grill-me', 'respec-cards'])
    for (const f of walk(path.join(skills, s))) {
      assert.notStrictEqual(path.basename(f), 'openai.yaml');
      if (f.endsWith('grilling.test.js')) continue;
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\/home\/|\/Users\/|\b[A-Za-z]:\\/, f);
    }
});
