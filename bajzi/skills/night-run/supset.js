#!/usr/bin/env node
'use strict';
// supset.js <night settings.local.json> <NIGHT_DIR> <out file>
// Writes the 30-minute supervisor's settings: the night settings with exactly THIS night's
// state*.txt Edit/Write deny removed (its re-queue duty deletes a state row), every other key and
// rule identical. Written atomically (tmp + rename) ONLY when exactly one rule was removed; else
// nothing is written and it exits 1 with a one-line reason on stderr. Rule forms: '~/' = $HOME,
// '//' = absolute root, anything else compared literally. Callers: SKILL.md PHASE C and
// supervise.sh at every tick (from BASE's installed .claude/settings.local.json).
const fs = require('node:fs');
const os = require('node:os');

const fail = (why, code = 1) => { process.stderr.write(`supset: ${why}\n`); process.exit(code); };
const [src, nightArg, out] = process.argv.slice(2);
if (!src || !nightArg || !out) fail('usage: supset.js <night settings.local.json> <NIGHT_DIR> <out file>', 2);

const want = nightArg.replace(/\/+$/, '') + '/state*.txt';
let s;
try { s = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { fail(`cannot read ${src}: ${e.message.split('\n')[0]}`); }
const deny = s && s.permissions && s.permissions.deny;
if (!Array.isArray(deny)) fail(`${src} has no permissions.deny list`);

const ownState = (r) => {
  const m = /^(?:Edit|Write)\((.*)\)$/.exec(r);
  const g = m && m[1];
  if (!g) return false;
  return (g.startsWith('~/') ? os.homedir() + g.slice(1) : g.startsWith('//') ? g.slice(1) : g) === want;
};
const drop = deny.filter((r) => typeof r === 'string' && ownState(r));
if (drop.length !== 1) fail(`${drop.length} rules in ${src} deny Edit/Write of ${want} (want exactly 1)${drop.length ? ': ' + drop.join(', ') : ''}; nothing written`);
s.permissions.deny = deny.filter((r) => !drop.includes(r));

const tmp = `${out}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, out);
} catch (e) {
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  fail(`cannot write ${out}: ${e.message.split('\n')[0]}`);
}
console.log(`supervisor settings: removed ${drop[0]}`);
