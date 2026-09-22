'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const ROUTER = path.join(__dirname, '..', 'cc-router.js');
const FAKE = path.join(__dirname, 'fake-claude.js');

// CC_CLAUDE_BIN = node itself, CC_CLAUDE_PREFIX_ARGS = [fake-claude.js]: the "claude" the router
// spawns is `node fake-claude.js <args...>`, which prints its env and argv and exits 0.
function run(entry, args, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'));
  const env = Object.assign({}, process.env, {
    CC_ROUTER_ENTRY: entry, CC_WORKER_MODE_FILE: path.join(dir, 'worker-mode'),
    CC_ROUTER_CONFIG: path.join(dir, 'cc-router.json'), CC_ROUTER_LOG: path.join(dir, 'cc-router.log'),
    CC_PROJECTS_DIR: path.join(dir, 'projects'), CC_CLAUDE_BIN: process.execPath,
    CC_CLAUDE_PREFIX_ARGS: JSON.stringify([FAKE]), ZAI_API_KEY: 'test-key',
    CC_GLM_PEAK_OK: '1',   // A4 adds the peak refusal; every other test must not depend on the clock
  });
  for (const k of ['CC_WORKER_MODE', 'CLAUDECODE']) delete env[k];   // the test process may run inside Claude Code
  for (const [k, v] of Object.entries(extraEnv)) { if (v === '' || v === undefined) delete env[k]; else env[k] = v; }
  const r = spawnSync(process.execPath, [ROUTER, ...args], { env, encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('FAKE_CLAUDE '));
  const parsed = line ? JSON.parse(line.slice(12)) : null;
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', dir,
    childEnv: parsed ? parsed.env : null, childArgv: parsed ? parsed.argv : null };
}
module.exports = { run };

test('seam: without CC_CLAUDE_PREFIX_ARGS the claude args pass through unchanged', () => {
  const script = 'console.log("ARGS", JSON.stringify(process.argv.slice(1)))';
  const r = run('worker', ['-e', script, 'zzz'], { CC_CLAUDE_PREFIX_ARGS: '' });   // '' deletes it
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /ARGS \["zzz"\]/);   // node saw exactly the trailing arg: no prefix, no reordering
});
test('baseline: worker --set glm writes the mode file', () => {
  const r = run('worker', ['--set', 'glm']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'worker-mode'), 'utf8'), 'glm\n');
});
test('baseline: glm entry routes to z.ai and maps haiku to the fast model', () => {
  const r = run('glm', ['-p', 'x', '--model', 'haiku']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7');   // DEFAULTS; the live config says glm-5.3-flash
  assert.deepStrictEqual(r.childArgv, ['-p', 'x', '--model', 'haiku']);      // caller args reach the child unchanged, in order
});
test('baseline: worker in claude mode passes no z.ai URL', () => {
  const r = run('worker', ['-p', 'x']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_BASE_URL, undefined);
});
test('seam: invalid JSON in CC_CLAUDE_PREFIX_ARGS is ignored (worker --status still exits 0)', () => {
  const r = run('worker', ['--status'], { CC_CLAUDE_PREFIX_ARGS: 'notjson' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /router\s+v1\.2\.0/);   // the admin path ran to completion: which success this is
});
test('seam: valid JSON that is not an array (5) is ignored on the spawn path', () => {
  const script = 'console.log("ARGS", JSON.stringify(process.argv.slice(1)))';
  const r = run('worker', ['-e', script, 'zzz'], { CC_CLAUDE_PREFIX_ARGS: '5' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /ARGS \["zzz"\]/);   // no prefix, no crash in PREFIX.concat
});
test('seam: valid JSON that is not an array ({}) is ignored on the spawn path', () => {
  const script = 'console.log("ARGS", JSON.stringify(process.argv.slice(1)))';
  const r = run('worker', ['-e', script, 'zzz'], { CC_CLAUDE_PREFIX_ARGS: '{}' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /ARGS \["zzz"\]/);
});
test('seam: invalid JSON on the spawn path starts the child with no prefix args', () => {
  const script = 'console.log("ARGS", JSON.stringify(process.argv.slice(1)))';
  const r = run('worker', ['-e', script, 'zzz'], { CC_CLAUDE_PREFIX_ARGS: 'notjson' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /ARGS \["zzz"\]/);
  assert.ok(!r.stderr.includes('concat'), r.stderr);   // a non-array PREFIX would die on PREFIX.concat
});

const LEVELS = [['0', 'claude'], ['1', 'light'], ['2', 'glm'], ['3', 'tight']];
for (const [n, name] of LEVELS) {
  test('worker --level ' + n + ' writes ' + name, () => {
    const r = run('worker', ['--level', n]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'worker-mode'), 'utf8'), name + '\n');
    assert.match(r.stdout, new RegExp('level L' + n + ' \\(' + name + '\\)'));
  });
}
test('worker --level 4 is refused with exit 64 and names the valid levels', () => {
  const r = run('worker', ['--level', '4']);
  assert.strictEqual(r.code, 64);
  assert.match(r.stderr, /usage: worker --level 0\|1\|2\|3/);
});
test('worker --level with no argument is refused with exit 64 and the usage message', () => {
  const r = run('worker', ['--level']);
  assert.strictEqual(r.code, 64);
  assert.match(r.stderr, /usage: worker --level 0\|1\|2\|3/);
});
test('worker --level 2x is refused with exit 64 and the usage message', () => {
  const r = run('worker', ['--level', '2x']);
  assert.strictEqual(r.code, 64);
  assert.match(r.stderr, /usage: worker --level 0\|1\|2\|3/);
});
test('CC_WORKER_MODE=light is accepted and routes worker to Claude', () => {
  const r = run('worker', ['-p', 'x'], { CC_WORKER_MODE: 'light' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_BASE_URL, undefined);
});
test('CC_WORKER_MODE=tight routes worker to GLM', () => {
  const r = run('worker', ['-p', 'x'], { CC_WORKER_MODE: 'tight' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
});
test('--status prints the level line', () => {
  const r = run('worker', ['--status'], { CC_WORKER_MODE: 'tight' });
  assert.match(r.stdout, /^level\s+L3 \(tight\)/m);
});
test('CC_WORKER_MODE=bogus is refused with exit 64 and names the valid modes', () => {
  const r = run('worker', ['-p', 'x'], { CC_WORKER_MODE: 'bogus' });
  assert.strictEqual(r.code, 64);
  assert.match(r.stderr, /CC_WORKER_MODE must be one of: claude, light, glm, tight/);
});
test('--until bounds the window', () => {
  const sb0 = run('worker', ['--status']);   // just for a sandbox dir
  const pj = path.join(sb0.dir, 'projects', 'p'); fs.mkdirSync(pj, { recursive: true });
  const rec = (h, m, model, id) => JSON.stringify({ type: 'assistant', requestId: id,
    timestamp: new Date(2026, 8, 21, h, m, 0).toISOString(), message: { model, usage: { output_tokens: 100 } } });
  fs.writeFileSync(path.join(pj, 'x.jsonl'), [rec(10, 0, 'glm-5.3', 'a'), rec(11, 0, 'claude-opus-5-5', 'b'), rec(11, 30, 'glm-5.3', 'd'), rec(12, 0, 'glm-5.3', 'c')].join('\n'));
  const r = run('worker', ['--usage', '2026-09-21T09:30', '--until', '2026-09-21T11:30', '--json'], { CC_PROJECTS_DIR: path.join(sb0.dir, 'projects') });
  assert.strictEqual(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.until, '2026-09-21T11:30');
  assert.strictEqual(typeof j.until_iso, 'string');
  assert.strictEqual(j.requests, 2);   // the 11:30 record 'd' is excluded: --until is exclusive
  assert.strictEqual(j.glm_share_pct, 50);
});
test('--until without a value is refused', () => {
  const r = run('worker', ['--usage', '1h', '--until']);
  assert.strictEqual(r.code, 64); assert.match(r.stderr, /--until needs a time/);
});
