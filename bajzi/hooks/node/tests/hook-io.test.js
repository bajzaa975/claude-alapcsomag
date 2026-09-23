'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_DIR, tmpDir } = require('./helpers');
const io = require('../lib/hook-io');

const HOOKIO = path.join(NODE_DIR, 'lib', 'hook-io.js');

function child(code, stdin, home) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
  const script = `const io = require(${JSON.stringify(HOOKIO)}); ${code}`;
  const r = spawnSync(process.execPath, ['-e', script], { input: stdin, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('RF2: parseInput returns null for empty, blank, garbage and non-object JSON', () => {
  for (const raw of ['', '   \n', 'not json', '{"a":', '[1,2]', 'null', '42', '"s"']) {
    assert.strictEqual(io.parseInput(raw), null, JSON.stringify(raw));
  }
  assert.strictEqual(io.parseInput(undefined), null);
});

test('RF2: parseInput strips a UTF-8 BOM and surrounding whitespace', () => {
  assert.deepStrictEqual(io.parseInput('\ufeff{"a":1}'), { a: 1 });
  assert.deepStrictEqual(io.parseInput('\n {"a":1}\r\n'), { a: 1 });
});

test('RF2: readInput in a child process: empty stdin -> null, BOM JSON -> object', () => {
  const home = tmpDir('bajzi-io-');
  const probe = 'process.stdout.write(JSON.stringify(io.readInput()))';
  assert.strictEqual(child(probe, '', home).stdout, 'null');
  assert.strictEqual(child(probe, 'garbage', home).stdout, 'null');
  assert.strictEqual(child(probe, '\ufeff{"session_id":"s"}', home).stdout, '{"session_id":"s"}');
});

test('deny writes the PreToolUse deny envelope with the rule id prefix', () => {
  const r = child("io.deny('because', 'rule-x')", '', tmpDir('bajzi-io-'));
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, '[bajzi:rule-x] because');
});

test('only the first emit reaches stdout (one JSON object per process)', () => {
  const r = child("io.addContext('PostToolUse', 'first'); io.deny('second', 'r')", '', tmpDir('bajzi-io-'));
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.additionalContext, 'first');
});

test('runHook fails open: a throw gives exit 0, empty stdout, one log line', () => {
  const home = tmpDir('bajzi-io-');
  const r = child("io.runHook('probe', () => { throw new Error('boom\\nline2'); })", '', home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  const log = fs.readFileSync(path.join(home, '.claude', 'bajzi', 'hook-errors.log'), 'utf8');
  assert.match(log, / probe boom line2\n$/);
});

test('logError caps the log at LOG_CAP and keeps the newest line', () => {
  const home = tmpDir('bajzi-io-');
  const dir = path.join(home, '.claude', 'bajzi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hook-errors.log');
  fs.writeFileSync(file, ('x'.repeat(99) + '\n').repeat(3000));   // 300 KB
  io.logError('cap', new Error('newest'), home);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(after) <= io.LOG_CAP, `size ${Buffer.byteLength(after)}`);
  assert.match(after, / cap newest\n$/);
  assert.match(after, /^x{99}\n/);   // cut on a line boundary, not mid-line
});

test('M1: runHook fails open on an async rejection (exit 0, silent, logged)', () => {
  const home = tmpDir('bajzi-io-');
  const r = child("io.runHook('probe', () => { Promise.reject(new Error('async boom')); })", '', home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  const log = fs.readFileSync(path.join(home, '.claude', 'bajzi', 'hook-errors.log'), 'utf8');
  assert.match(log, / probe async boom\n$/);
});

test('M1: runHook fails open on a throw inside setTimeout', () => {
  const home = tmpDir('bajzi-io-');
  const r = child("io.runHook('probe', () => { setTimeout(() => { throw new Error('late boom'); }, 5); })", '', home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  const log = fs.readFileSync(path.join(home, '.claude', 'bajzi', 'hook-errors.log'), 'utf8');
  assert.match(log, / probe late boom\n$/);
});

test('M2: an EPIPE on the stdout write stays fail-open outside runHook', () => {
  const home = tmpDir('bajzi-io-');
  const patch = "const fs = require('fs'); const w = fs.writeSync; fs.writeSync = (fd, ...a) => { " +
    "if (fd === 1) { const e = new Error('EPIPE: broken pipe'); e.code = 'EPIPE'; throw e; } return w(fd, ...a); };";
  const r = child(patch + " io.deny('x', 'r'); w(2, 'alive')", '', home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, 'alive');
  assert.strictEqual(r.stdout, '');
});

test('M2: short writes are looped until the whole payload is out', () => {
  const home = tmpDir('bajzi-io-');
  const patch = "const fs = require('fs'); const w = fs.writeSync; fs.writeSync = (fd, buf, off, len, pos) => { " +
    "if (fd !== 1) return w(fd, buf, off, len, pos); const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); " +
    "return w(1, b, off || 0, Math.min(1, len === undefined ? b.length : len)); };";
  const r = child(patch + " io.addContext('PostToolUse', 'a longer payload é')", '', home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'a longer payload é');
});
