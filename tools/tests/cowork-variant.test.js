'use strict';
// bajzi-cowork must stay (1) a byte-exact build of bajzi/skills, (2) free of anything the
// claude.ai-hosted marketplace sync rejects or that cannot run there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { drift, SKILLS, DST } = require('../build-cowork');

test('bajzi-cowork is in sync with bajzi/ (run node tools/build-cowork.js)', () => {
  assert.deepStrictEqual(drift(), []);
});

test('bajzi-cowork ships no bin/, hooks/, agents/, gate/, lib/', () => {
  for (const d of ['bin', 'hooks', 'agents', 'gate', 'lib']) {
    assert.ok(!fs.existsSync(path.join(DST, d)), `bajzi-cowork/${d} must not exist`);
  }
});

test('shipped skills reference nothing outside their own folder', () => {
  const bad = /CLAUDE_PLUGIN_ROOT|\.\.\/\.\.\/|cc-router/;
  for (const s of SKILLS) {
    const md = fs.readFileSync(path.join(DST, 'skills', s, 'SKILL.md'), 'utf8');
    assert.ok(!bad.test(md), `${s}/SKILL.md references plugin-level files`);
  }
});

test('no shipped file names a /bajzi: command (the variant ships /bajzi-cowork:)', () => {
  for (const s of SKILLS) {
    for (const f of fs.readdirSync(path.join(DST, 'skills', s), { recursive: true })) {
      const p = path.join(DST, 'skills', s, f);
      if (fs.statSync(p).isFile()) assert.ok(!/\/bajzi:/.test(fs.readFileSync(p, 'utf8')), `${s}/${f} names a /bajzi: command`);
    }
  }
});

test('no shipped file names a bajzi skill outside the cowork skill list', () => {
  for (const s of SKILLS) {
    for (const f of fs.readdirSync(path.join(DST, 'skills', s), { recursive: true })) {
      const p = path.join(DST, 'skills', s, f);
      if (!fs.statSync(p).isFile()) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bbajzi:([a-z-]+)/g)) assert.ok(SKILLS.includes(m[1]), `${s}/${f} names bajzi:${m[1]}`);
    }
  }
});

test('SKILLS whitelist has explain, not tired', () => {
  assert.ok(SKILLS.includes('explain'));
  assert.ok(!SKILLS.includes('tired'));
});
