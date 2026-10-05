'use strict';
// supset.js: the supervisor's settings = the night settings minus exactly THIS night's state*.txt
// Edit/Write deny, written atomically, and nothing written unless exactly one rule was removed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUPSET = path.join(__dirname, '..', 'supset.js');
const HOME = '/home/tester';             // '~/' expands to this (forward slashes: compared as a string)
const NIGHT = HOME + '/night-runs/bss';
const OTHER = 'Edit(~/night-runs/other/state*.txt)';

function run(deny, extra = {}, outRel = 'supervise.settings.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supset-'));
  const src = path.join(dir, 'night.json');
  const out = path.join(dir, outRel);
  const night = { permissions: { allow: ['Bash(git status)'], deny }, ...extra };
  fs.writeFileSync(src, JSON.stringify(night, null, 2));
  const r = spawnSync(process.execPath, [SUPSET, src, NIGHT + '/', out],
    { encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, MSYS_NO_PATHCONV: '1' } });
  return { r, dir, out, night, files: () => fs.readdirSync(dir).sort() };
}

test('removes exactly this night\'s ~/ state deny, keeps every other key and rule', () => {
  const { r, out, night } = run(['Read(**/.env)', 'Edit(~/night-runs/bss/state*.txt)', OTHER], { env: { X: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  night.permissions.deny = ['Read(**/.env)', OTHER];
  assert.deepStrictEqual(got, night);
  assert.match(r.stdout, /removed Edit\(~\/night-runs\/bss\/state\*\.txt\)/);
});

test('an absolute // Write form of this night\'s state deny is removed too', () => {
  const { r, out } = run([`Write(/${NIGHT}/state*.txt)`, OTHER]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).permissions.deny, [OTHER]);
});

test('another night\'s state deny alone = zero matches: non-zero, no output, no temp file', () => {
  const { r, out, files } = run([OTHER, 'Read(**/.env)']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /supset: .*0 rules/);
  assert.ok(!fs.existsSync(out));
  assert.deepStrictEqual(files(), ['night.json']);
});

test('two matches (Edit + Write): non-zero, no output, no temp file', () => {
  const { r, out, files } = run(['Edit(~/night-runs/bss/state*.txt)', 'Write(~/night-runs/bss/state*.txt)']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /supset: .*2 rules/);
  assert.ok(!fs.existsSync(out));
  assert.deepStrictEqual(files(), ['night.json']);
});

test('a stale output file is replaced whole (tmp + rename, no temp file left)', () => {
  const { dir, out } = run([]);
  fs.writeFileSync(out, '{"stale":true}');
  fs.writeFileSync(path.join(dir, 'night.json'),
    JSON.stringify({ permissions: { deny: ['Edit(~/night-runs/bss/state*.txt)', OTHER] } }));
  const r = spawnSync(process.execPath, [SUPSET, path.join(dir, 'night.json'), NIGHT, out],
    { encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { permissions: { deny: [OTHER] } });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['night.json', 'supervise.settings.json']);
});

test('unreadable source or no permissions.deny: one-line reason, non-zero, nothing written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supset-'));
  const out = path.join(dir, 'o.json');
  let r = spawnSync(process.execPath, [SUPSET, path.join(dir, 'missing.json'), NIGHT, out], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /^supset: /);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  fs.writeFileSync(path.join(dir, 'n.json'), '{"permissions":{}}');
  r = spawnSync(process.execPath, [SUPSET, path.join(dir, 'n.json'), NIGHT, out], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(!fs.existsSync(out));
});

test('unwritable output path: one "cannot write" line, non-zero, no output or temp file left', () => {
  const { r, dir, files } = run(['Edit(~/night-runs/bss/state*.txt)', OTHER], {}, 'nodir/out.json');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /^supset: cannot write /);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.deepStrictEqual(files(), ['night.json']);
  assert.ok(!fs.existsSync(path.join(dir, 'nodir')));
});
