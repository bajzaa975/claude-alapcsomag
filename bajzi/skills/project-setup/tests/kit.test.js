'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const K = require('../kit');

const BEGIN = '<!-- bajzi:project-setup kit begin -->';
const END = '<!-- bajzi:project-setup kit end -->';

test('SIZES and rank order XS < S < M < L', () => {
  assert.deepStrictEqual(K.SIZES, ['XS', 'S', 'M', 'L']);
  assert.ok(K.rank('XS') < K.rank('S') && K.rank('S') < K.rank('M') && K.rank('M') < K.rank('L'));
});

test('sizeBlock XS: XS rules, hosting line, only the XS -> S trigger', () => {
  const b = K.sizeBlock('XS', 'local');
  assert.ok(b.startsWith(BEGIN + '\n## Project size: XS   (hosting: local)\n'));
  assert.ok(b.endsWith('\n' + END));
  assert.match(b, /- No secrets in files: keyring references only\./);
  assert.doesNotMatch(b, /Tests for every behaviour change/);
  assert.match(b, /- Hosting local: never push to GitHub; \.githooks\/pre-push refuses GitHub remotes\./);
  assert.match(b, /## Size triggers \(check before writing every new plan\)\n- XS -> S: /);
  assert.doesNotMatch(b, /- -> M:|- -> L:/);
  assert.match(b, /- When one fires: propose the upgrade/);
});

test('sizeBlock S and XS: the upgrade line says to add "gate" for M/L, as SKILL.md Size upgrade does', () => {
  for (const s of ['XS', 'S']) assert.match(K.sizeBlock(s, 'local'), /- When one fires: [^\n]*for M\/L also add "gate"/, s);
});

test('sizeBlock S: XS + S rules, -> M and -> L triggers; github hosting line', () => {
  const b = K.sizeBlock('S', 'github');
  assert.match(b, /## Project size: S   \(hosting: github\)/);
  assert.match(b, /- General repo:/);
  assert.match(b, /- Done = tests green, the plan's items done, handoff updated\./);
  assert.doesNotMatch(b, /pre-commit gate must pass/);
  assert.match(b, /- Hosting github: GitHub pushes allowed\.\n## Size triggers/);
  assert.doesNotMatch(b, /XS -> S/);
  assert.match(b, /- -> M: /);
  assert.match(b, /- -> L: /);
});

test('sizeBlock M: cumulative up to M, only the -> L trigger', () => {
  const b = K.sizeBlock('M', 'local');
  assert.match(b, /- Done = tests green, the plan's items done, handoff updated\.\n- The bajzi pre-commit gate must pass; never --no-verify\./);
  assert.match(b, /- Done = S \+ gate green \+ review CLEAN \+ UAT checklist passed\./);
  assert.doesNotMatch(b, /CI required/);
  assert.doesNotMatch(b, /- -> M: /);
  assert.match(b, /- -> L: /);
});

test('sizeBlock L: every rule, no triggers section', () => {
  const b = K.sizeBlock('L', 'github');
  for (const r of ['- General repo:', '- Tests for every behaviour change.', '- UAT checklist per release', '- CI required:', '- Done = M + CI green + release notes + rollback plan.']) assert.ok(b.includes(r), r);
  assert.doesNotMatch(b, /Size triggers/);
  assert.ok(b.endsWith('- Hosting github: GitHub pushes allowed.\n' + END));
});

test('scaffold is cumulative: XS/S none, M uat+deploy, L adds changelog, rollback, definition of done', () => {
  const rels = s => K.scaffold(s).map(f => f.rel);
  assert.deepStrictEqual(rels('XS'), []);
  assert.deepStrictEqual(rels('S'), []);
  assert.deepStrictEqual(rels('M'), ['docs/uat/README.md', 'docs/DEPLOY.md']);
  assert.deepStrictEqual(rels('L'), ['docs/uat/README.md', 'docs/DEPLOY.md', 'CHANGELOG.md', 'docs/rollback.md', 'docs/definition-of-done.md']);
  for (const f of K.scaffold('L')) assert.match(f.text, /TODO/, f.rel);
  const dod = K.scaffold('L').find(f => f.rel === 'docs/definition-of-done.md').text;
  assert.match(dod, /Done = M \+ CI green \+ release notes \+ rollback plan\./);
});
