'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const ROUTER = path.join(__dirname, '..', 'cc-router.js');
const FAKE = path.join(__dirname, 'fake-claude.js');

// CC_CLAUDE_BIN = node itself, CC_CLAUDE_PREFIX_ARGS = [fake-claude.js]: the "claude" the router
// spawns is `node fake-claude.js <args...>`, which prints its env and argv and exits 0.
function run(entry, args, extraEnv = {}, opts = {}) {   // opts.cwd: the router's working directory
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'));
  const env = Object.assign({}, process.env, {
    CC_ROUTER_ENTRY: entry, CC_WORKER_MODE_FILE: path.join(dir, 'worker-mode'),
    CC_ROUTER_CONFIG: path.join(dir, 'cc-router.json'), CC_ROUTER_LOG: path.join(dir, 'cc-router.log'),
    CC_PROJECTS_DIR: path.join(dir, 'projects'), CC_CLAUDE_BIN: process.execPath,
    CC_CLAUDE_PREFIX_ARGS: JSON.stringify([FAKE]), ZAI_API_KEY: 'test-key',
    CC_GLM_PEAK_OK: '1',   // A4 adds the peak refusal; every other test must not depend on the clock
    BAJZI_STATUS_DIR: path.join(dir, 'sessions'),   // session level files land in the sandbox, never the real home
  });
  // The test process may run inside Claude Code: its session id must never reach the router unless a test sets it.
  for (const k of ['CC_WORKER_MODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'BAJZI_HOME', 'BAJZI_SESSION_LEVEL',
    'GLM_MODEL', 'GLM_FAST_MODEL', 'GLM_ORCHESTRATOR_MODEL']) delete env[k];
  for (const [k, v] of Object.entries(extraEnv)) {
    for (const o of Object.keys(env)) if (o !== k && o.toUpperCase() === k.toUpperCase()) delete env[o];   // win32 copies PATH as Path
    if (v === '' || v === undefined) delete env[k]; else env[k] = v;
  }
  const r = spawnSync(process.execPath, [ROUTER, ...args], { env, encoding: 'utf8', cwd: opts.cwd });
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
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');   // DEFAULTS glm_fast_model
  assert.deepStrictEqual(r.childArgv, ['--settings', JSON.stringify({ modelOverrides: { 'claude-opus-4-1': 'glm-5.3', 'claude-haiku-4-5': 'glm-5.3-flash' } }), '-p', 'x', '--model', 'haiku']);   // modelOverrides pair first; sonnet dropped, its default equals fast's
});
test('glm injects modelOverrides (opus -> orchestrator, haiku -> fast): the sdk warning resolves ids only through them', () => {
  const r = run('glm', ['-p', 'x']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childArgv[0], '--settings');
  assert.deepStrictEqual(JSON.parse(r.childArgv[1]).modelOverrides, { 'claude-opus-4-1': 'glm-5.3', 'claude-haiku-4-5': 'glm-5.3-flash' });
});
test('glm: a caller --settings (both spellings) is passed through, nothing injected', () => {
  for (const a of [['--settings', 'mine.json'], ['--settings=mine.json']]) {
    const r = run('glm', ['-p', 'x', ...a]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(r.childArgv, ['-p', 'x', ...a]);
  }
});
test('worker in claude mode injects no --settings', () => {
  const r = run('worker', ['-p', 'x']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.childArgv, ['-p', 'x']);
});
test('glm: GLM_FAST_MODEL lands in the haiku modelOverrides entry, all three entries present when distinct', () => {
  const r = run('glm', ['-p', 'x'], { GLM_FAST_MODEL: 'glm-9-flash' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.childArgv[1]).modelOverrides, { 'claude-opus-4-1': 'glm-5.3', 'claude-haiku-4-5': 'glm-9-flash', 'claude-sonnet-4-5': 'glm-5.3-flash' });
});
test('glm: GLM_MODEL distinct from the fast model keeps all three entries (sonnet -> glm_model)', () => {
  const r = run('glm', ['-p', 'x'], { GLM_MODEL: 'glm-9' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.childArgv[1]).modelOverrides, { 'claude-opus-4-1': 'glm-5.3', 'claude-haiku-4-5': 'glm-5.3-flash', 'claude-sonnet-4-5': 'glm-9' });
});
test('glm: GLM_FAST_MODEL equal to the orchestrator model drops the later duplicate (haiku) entry', () => {
  const r = run('glm', ['-p', 'x'], { GLM_FAST_MODEL: 'glm-5.3' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.childArgv[1]).modelOverrides, { 'claude-opus-4-1': 'glm-5.3', 'claude-sonnet-4-5': 'glm-5.3-flash' });
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

// --- A4: Z.ai peak-window refusal (06:00-10:00 UTC = 14:00-18:00 UTC+8) and the child-worker marker ---
const peakEnv = now => ({ CC_GLM_PEAK_OK: '', CC_ROUTER_NOW: now, CC_PEAK_LOG: path.join(os.tmpdir(), 'peak-' + process.pid + '-' + Math.random()) });
test('glm inside the window (07:00 UTC) exits 75 and logs the refusal', () => {
  const e = peakEnv('2026-09-23T07:00:00Z');
  const r = run('glm', ['-p', 'x'], e);
  assert.strictEqual(r.code, 75);
  assert.match(r.stderr, /peak window/);
  assert.strictEqual(r.childEnv, null);                 // claude never started
  assert.match(fs.readFileSync(e.CC_PEAK_LOG, 'utf8'), /^2026-09-23T07:00:00/);
});
test('glm at 06:00 UTC (first minute of the window) is refused', () => {
  const r = run('glm', ['-p', 'x'], peakEnv('2026-09-23T06:00:00Z'));
  assert.strictEqual(r.code, 75);
  assert.match(r.stderr, /peak window/);
  assert.strictEqual(r.childEnv, null);
});
test('glm at 05:59 UTC and at 10:00 UTC starts', () => {
  for (const t of ['2026-09-23T05:59:00Z', '2026-09-23T10:00:00Z']) {
    const r = run('glm', ['-p', 'x'], peakEnv(t));
    assert.strictEqual(r.code, 0, t + ' ' + r.stderr);
    assert.notStrictEqual(r.childEnv, null, t);
  }
});
test('CC_GLM_PEAK_OK=1 bypasses the refusal', () => {
  const r = run('glm', ['-p', 'x'], Object.assign(peakEnv('2026-09-23T07:00:00Z'), { CC_GLM_PEAK_OK: '1' }));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.notStrictEqual(r.childEnv, null);
});
test('worker at L3 is refused in the window too; worker at L1 is not', () => {
  const t = run('worker', ['-p', 'x'], Object.assign(peakEnv('2026-09-23T07:00:00Z'), { CC_WORKER_MODE: 'tight' }));
  assert.strictEqual(t.code, 75);
  assert.match(t.stderr, /peak window/);
  assert.strictEqual(t.childEnv, null);
  const l = run('worker', ['-p', 'x'], Object.assign(peakEnv('2026-09-23T07:00:00Z'), { CC_WORKER_MODE: 'light' }));
  assert.strictEqual(l.code, 0, l.stderr);
  assert.strictEqual(l.childEnv.ANTHROPIC_BASE_URL, undefined);
});
test('ccr code (GLM provider) is refused in the window', () => {
  const r = run('ccr', ['code', '-p', 'x'], peakEnv('2026-09-23T07:00:00Z'));
  assert.strictEqual(r.code, 75);
  assert.match(r.stderr, /peak window/);
  assert.strictEqual(r.childEnv, null);
});
test('an unparsable CC_ROUTER_NOW falls back to the real clock instead of disabling the check', () => {
  const inWindow = (h => h >= 6 && h < 10)(new Date().getUTCHours());
  const r = run('glm', ['-p', 'x'], peakEnv('not-a-date'));
  assert.strictEqual(r.code, inWindow ? 75 : 0, r.stderr);
});
test('launched from inside Claude Code -> child gets CC_ROUTER_WORKER=1; from a plain shell -> not', () => {
  assert.strictEqual(run('glm', ['-p', 'x'], { CLAUDECODE: '1' }).childEnv.CC_ROUTER_WORKER, '1');
  assert.strictEqual(run('glm', ['-p', 'x'], { CLAUDECODE: '' }).childEnv.CC_ROUTER_WORKER, undefined);
});
test('a CC_ROUTER_WORKER inherited from a plain shell is not passed on', () => {
  assert.strictEqual(run('glm', ['-p', 'x'], { CC_ROUTER_WORKER: '1' }).childEnv.CC_ROUTER_WORKER, undefined);
});

// --- per-session saver level: a level set from inside a session applies to that session only ---
const SID = 'sess-A_1';
const lvlFile = (dir, id = SID) => path.join(dir, 'sessions', id + '.level');
const readOr = p => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
test('router SAFE_ID and status dir stay in sync with hooks/node/lib/session-status.js', () => {
  const ss = require('../../hooks/node/lib/session-status');
  const src = fs.readFileSync(ROUTER, 'utf8');
  assert.ok(src.includes('/' + ss.SAFE_ID.source + '/'), 'SAFE_ID drifted');
  assert.ok(src.includes("'.claude', 'bajzi', 'sessions'"), 'status dir drifted');
});
test('--level inside a session writes ONLY the session level file; worker-mode untouched', () => {
  const r = run('worker', ['--level', '3'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(readOr(lvlFile(r.dir)), 'tight\n');
  assert.strictEqual(readOr(path.join(r.dir, 'worker-mode')), null);
  assert.ok(r.stdout.includes('level L3 for this session (' + SID + '); other sessions unchanged. Use --level N --global for the machine default.'), r.stdout);
  assert.deepStrictEqual(fs.readdirSync(path.join(r.dir, 'sessions')), [SID + '.level']);   // no tmp file left behind
});
test('--level and --set say the level does not switch the provider of a running session', () => {
  const NS = 'The level does not switch the provider of a session that is already running: a GLM session starts with worker (or glm).';
  for (const [a, e] of [[['--level', '3'], { CLAUDE_CODE_SESSION_ID: SID }], [['--set', 'glm', '--global'], { CLAUDE_CODE_SESSION_ID: SID }], [['--level', '1'], {}]]) {
    const r = run('worker', a, e);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(NS), r.stdout);
  }
});
test('--level N --global inside a session writes worker-mode, not the session file', () => {
  const r = run('worker', ['--level', '2', '--global'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(readOr(path.join(r.dir, 'worker-mode')), 'glm\n');
  assert.strictEqual(readOr(lvlFile(r.dir)), null);
  assert.match(r.stdout, /level L2 \(glm\)/);
  assert.match(r.stdout, /running sessions that set their own level keep it/);
});
test('--level with no session id writes worker-mode and says sessions with their own level keep it', () => {
  const r = run('worker', ['--level', '1']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(readOr(path.join(r.dir, 'worker-mode')), 'light\n');
  assert.ok(!fs.existsSync(path.join(r.dir, 'sessions')));
  assert.match(r.stdout, /running sessions that set their own level keep it/);
});
test('--global may come before the number', () => {
  const r = run('worker', ['--level', '--global', '3'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(readOr(path.join(r.dir, 'worker-mode')), 'tight\n');
  assert.strictEqual(readOr(lvlFile(r.dir)), null);
});
test('--set inside a session is per session too; --set --global is the machine default', () => {
  const r = run('worker', ['--set', 'tight'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(readOr(lvlFile(r.dir)), 'tight\n');
  assert.strictEqual(readOr(path.join(r.dir, 'worker-mode')), null);
  const g = run('worker', ['--set', 'glm', '--global'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.strictEqual(g.code, 0, g.stderr);
  assert.strictEqual(readOr(path.join(g.dir, 'worker-mode')), 'glm\n');
  assert.strictEqual(readOr(lvlFile(g.dir)), null);
});
test('an unsafe CLAUDE_CODE_SESSION_ID ("../x") writes worker-mode, nothing under the status dir, and falls back to the machine default', () => {
  const r = run('worker', ['--level', '3'], { CLAUDE_CODE_SESSION_ID: '../x' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(readOr(path.join(r.dir, 'worker-mode')), 'tight\n');
  assert.ok(!fs.existsSync(path.join(r.dir, 'x.level')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'sessions')));
  // reading: an unsafe id never selects a file outside the status dir
  fs.writeFileSync(path.join(r.dir, 'x.level'), 'claude\n');
  const s = run('worker', ['--status'], { CLAUDE_CODE_SESSION_ID: '../x', CC_WORKER_MODE_FILE: path.join(r.dir, 'worker-mode'), BAJZI_STATUS_DIR: path.join(r.dir, 'sessions') });
  assert.match(s.stdout, /^level\s+L3 \(tight\)\s+\(machine default/m);
});
test('a launch inside a session resolves the session level over worker-mode', () => {
  const sb = run('worker', ['--level', '0', '--global']);   // machine default claude
  fs.mkdirSync(path.join(sb.dir, 'sessions'));
  fs.writeFileSync(lvlFile(sb.dir), '\ufeffTIGHT\r\n');
  const env = { CC_WORKER_MODE_FILE: path.join(sb.dir, 'worker-mode'), BAJZI_STATUS_DIR: path.join(sb.dir, 'sessions') };
  const a = run('worker', ['-p', 'x'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID }, env));
  assert.strictEqual(a.code, 0, a.stderr);
  assert.strictEqual(a.childEnv.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  const b = run('worker', ['-p', 'x'], Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-B' }, env));
  assert.strictEqual(b.code, 0, b.stderr);
  assert.strictEqual(b.childEnv.ANTHROPIC_BASE_URL, undefined);   // session B: machine default claude
  assert.ok(!fs.existsSync(lvlFile(sb.dir, 'sess-B')));            // a launch never writes a session file
  const e = run('worker', ['-p', 'x'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID, CC_WORKER_MODE: 'light' }, env));
  assert.strictEqual(e.childEnv.ANTHROPIC_BASE_URL, undefined);   // env beats the session file
});
test('a launch from a session passes the session level to the child as BAJZI_SESSION_LEVEL, never CC_WORKER_MODE', () => {
  const sb = run('worker', ['--level', '0', '--global']);
  fs.mkdirSync(path.join(sb.dir, 'sessions'));
  fs.writeFileSync(lvlFile(sb.dir), 'tight\n');
  const env = { CC_WORKER_MODE_FILE: path.join(sb.dir, 'worker-mode'), BAJZI_STATUS_DIR: path.join(sb.dir, 'sessions') };
  const a = run('worker', ['-p', 'x'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID }, env));
  assert.strictEqual(a.childEnv.BAJZI_SESSION_LEVEL, 'tight');
  assert.strictEqual(a.childEnv.CC_WORKER_MODE, undefined);   // CC_WORKER_MODE would open the saver gate
  const n = run('worker', ['-p', 'x'], Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-B', BAJZI_SESSION_LEVEL: 'tight' }, env));
  assert.strictEqual(n.childEnv.BAJZI_SESSION_LEVEL, 'tight');   // nested launch keeps the pin
  assert.match(run('worker', ['--status'], Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-B', BAJZI_SESSION_LEVEL: 'tight' }, env)).stdout, /^level\s+L3 \(tight\)\s+\(session \(inherited\)\)/m);
  const b = run('worker', ['-p', 'x'], Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-B' }, env));
  assert.strictEqual(b.childEnv.BAJZI_SESSION_LEVEL, undefined);   // machine default is not pinned
});
test('an unknown inherited BAJZI_SESSION_LEVEL reads as claude and a nested launch pins claude', () => {
  const sb = run('worker', ['--level', '2', '--global']);   // machine default glm: the inherited word must still win
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-B', BAJZI_SESSION_LEVEL: 'turbo', CC_WORKER_MODE_FILE: path.join(sb.dir, 'worker-mode'), BAJZI_STATUS_DIR: path.join(sb.dir, 'sessions') };
  assert.match(run('worker', ['--status'], env).stdout, /^level\s+L0 \(claude\)\s+\(session \(inherited\)\)/m);
  const n = run('worker', ['-p', 'x'], env);
  assert.strictEqual(n.code, 0, n.stderr);
  assert.strictEqual(n.childEnv.BAJZI_SESSION_LEVEL, 'claude');
  assert.strictEqual(n.childEnv.CC_WORKER_MODE, undefined);
  assert.strictEqual(n.childEnv.ANTHROPIC_BASE_URL, undefined);
});
test('a failing level write exits 73 "cannot write" and leaves no temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-w-'));
  fs.writeFileSync(path.join(dir, 'sessions'), 'x');   // status dir path is a regular file: mkdir fails
  const r = run('worker', ['--level', '3'], { CLAUDE_CODE_SESSION_ID: SID, BAJZI_STATUS_DIR: path.join(dir, 'sessions') });
  assert.strictEqual(r.code, 73);
  assert.match(r.stderr, /cannot write/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['sessions']);
});
test('an empty session file falls through to worker-mode', () => {
  const sb = run('worker', ['--level', '2', '--global']);
  fs.mkdirSync(path.join(sb.dir, 'sessions'));
  fs.writeFileSync(lvlFile(sb.dir), '\n');
  const s = run('worker', ['--status'], { CLAUDE_CODE_SESSION_ID: SID, CC_WORKER_MODE_FILE: path.join(sb.dir, 'worker-mode'), BAJZI_STATUS_DIR: path.join(sb.dir, 'sessions') });
  assert.match(s.stdout, /^level\s+L2 \(glm\)\s+\(machine default/m);
});
test('--status shows the level source: env / session / machine default / none', () => {
  const sb = run('worker', ['--level', '2', '--global']);
  const env = { CC_WORKER_MODE_FILE: path.join(sb.dir, 'worker-mode'), BAJZI_STATUS_DIR: path.join(sb.dir, 'sessions') };
  run('worker', ['--level', '3'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID }, env));
  assert.match(run('worker', ['--status'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID }, env)).stdout, /^level\s+L3 \(tight\)\s+\(session /m);
  assert.match(run('worker', ['--status'], Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-B' }, env)).stdout, /^level\s+L2 \(glm\)\s+\(machine default/m);
  assert.match(run('worker', ['--status'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID, CC_WORKER_MODE: 'light' }, env)).stdout, /^level\s+L1 \(light\)\s+\(env /m);
  assert.match(run('worker', ['--status']).stdout, /^level\s+L0 \(claude\)\s+\(none/m);
  assert.match(run('worker', ['--mode'], Object.assign({ CLAUDE_CODE_SESSION_ID: SID }, env)).stdout, /^tight$/m);
});

// --- GLM model split: a top-level session runs on glm_orchestrator_model; everything nested
// (CLAUDECODE set: sub-agents' `glm -p` workers) and every sub-agent on glm_model / glm_fast_model ---
// fake-claude.js records no DEFAULT_OPUS/SONNET, so these tests use a fuller fake through the same seam.
const FULL_FAKE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-fake-')), 'fake-full.js');
fs.writeFileSync(FULL_FAKE, 'const out = {}; for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_SUBAGENT_MODEL$|CC_ROUTER_WORKER$)/.test(k)) out[k] = process.env[k];\n' +
  'process.stdout.write("FAKE_CLAUDE " + JSON.stringify({ env: out, argv: process.argv.slice(2) }) + "\\n");\n');
const runFull = (args, extra = {}) => run('glm', args, Object.assign({ CC_CLAUDE_PREFIX_ARGS: JSON.stringify([FULL_FAKE]) }, extra));
const lastLog = r => fs.readFileSync(path.join(r.dir, 'cc-router.log'), 'utf8').trimEnd().split('\n').pop();
test('top-level GLM launch, no --model: main = orchestrator glm-5.3, sub-agents and haiku = glm-5.3-flash', () => {
  const r = runFull(['-p', 'x'], { CLAUDECODE: '' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_MODEL, 'glm-5.3');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.3');
  assert.strictEqual(r.childEnv.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.3-flash');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
  assert.match(lastLog(r), / asked=- model=glm-5\.3 /);   // the log names the model actually served
});
test('top-level GLM launch --model OPUS[1m]: DEFAULT_OPUS = glm-5.3, no ANTHROPIC_MODEL override, log says glm-5.3', () => {
  const r = runFull(['-p', 'x', '--model', 'OPUS[1m]'], { CLAUDECODE: '' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3');
  assert.strictEqual(r.childEnv.ANTHROPIC_MODEL, undefined);
  assert.strictEqual(r.childEnv.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.3-flash');
  assert.match(lastLog(r), / asked=OPUS\[1m\] model=glm-5\.3 /);
  const o = runFull(['-p', 'x', '--model', 'opus'], { CLAUDECODE: '' });
  assert.strictEqual(o.childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3');
  assert.strictEqual(o.childEnv.ANTHROPIC_MODEL, undefined);
  const id = runFull(['-p', 'x', '--model', 'glm-9'], { CLAUDECODE: '' });   // an explicit non-alias id passes through
  assert.match(lastLog(id), / asked=glm-9 model=glm-9 /);
});
test('nested GLM launch (CLAUDECODE=1) -p --model opus: every alias and the sub-agents land on glm-5.3-flash', () => {
  const r = runFull(['-p', 'x', '--model', 'opus'], { CLAUDECODE: '1' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3-flash');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.3-flash');
  assert.strictEqual(r.childEnv.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.3-flash');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
  assert.strictEqual(r.childEnv.ANTHROPIC_MODEL, undefined);
  assert.match(lastLog(r), / asked=opus model=glm-5\.3-flash /);
  const n = runFull(['-p', 'x'], { CLAUDECODE: '1' });
  assert.strictEqual(n.childEnv.ANTHROPIC_MODEL, 'glm-5.3-flash');
  assert.match(lastLog(n), / asked=- model=glm-5\.3-flash /);
});
test('nested GLM launch (CLAUDECODE=1): the opus override follows glm_model, not the orchestrator', () => {
  const r = runFull(['-p', 'x'], { CLAUDECODE: '1', GLM_MODEL: 'glm-9' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-9');
  assert.deepStrictEqual(JSON.parse(r.childArgv[1]).modelOverrides, { 'claude-opus-4-1': 'glm-9', 'claude-haiku-4-5': 'glm-5.3-flash' });   // sonnet dropped: its model equals opus's
});
test('worker --set-orchestrator-model writes the key and --status shows it; a bad id is refused', () => {
  const r = run('worker', ['--set-orchestrator-model', 'glm-6']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'cc-router.json'), 'utf8')).glm_orchestrator_model, 'glm-6');
  const s = run('worker', ['--status'], { CC_ROUTER_CONFIG: path.join(r.dir, 'cc-router.json') });
  assert.match(s.stdout, /^orchestrator    glm-6$/m);
  assert.match(s.stdout, /^glm model       glm-5\.3-flash$/m);
  assert.match(s.stdout, /^glm fast model  glm-5\.3-flash$/m);
  const top = runFull(['-p', 'x'], { CC_ROUTER_CONFIG: path.join(r.dir, 'cc-router.json') });
  assert.strictEqual(top.childEnv.ANTHROPIC_MODEL, 'glm-6');
  const bad = run('worker', ['--set-orchestrator-model', 'a b']);
  assert.strictEqual(bad.code, 64);
  assert.match(bad.stderr, /usage: worker --set-orchestrator-model <model-id>/);
  assert.match(run('worker', ['--router-help']).stdout, /--set-orchestrator-model <id>/);
});
test('a single worker --set-model writes only glm_model; the other two keys stay code defaults', () => {
  const a = run('worker', ['--set-model', 'glm-a']);
  assert.strictEqual(a.code, 0, a.stderr);
  const conf = path.join(a.dir, 'cc-router.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(conf, 'utf8')), { glm_model: 'glm-a' });
  const s = run('worker', ['--status'], { CC_ROUTER_CONFIG: conf });
  assert.match(s.stdout, /^orchestrator    glm-5\.3$/m);
  assert.match(s.stdout, /^glm fast model  glm-5\.3-flash$/m);
});
test('worker --set-model / --set-fast-model write their own key and leave the orchestrator default', () => {
  const a = run('worker', ['--set-model', 'glm-a']);
  assert.strictEqual(a.code, 0, a.stderr);
  const conf = path.join(a.dir, 'cc-router.json');
  assert.strictEqual(run('worker', ['--set-fast-model', 'glm-b'], { CC_ROUTER_CONFIG: conf }).code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(conf, 'utf8')), { glm_model: 'glm-a', glm_fast_model: 'glm-b' });
  const s = run('worker', ['--status'], { CC_ROUTER_CONFIG: conf });
  assert.match(s.stdout, /^glm model       glm-a$/m);
  assert.match(s.stdout, /^glm fast model  glm-b$/m);
});
test('GLM_ORCHESTRATOR_MODEL forces the orchestrator model (status says so, launch uses it)', () => {
  const s = run('worker', ['--status'], { GLM_ORCHESTRATOR_MODEL: 'glm-7' });
  assert.match(s.stdout, /^orchestrator    glm-7   \(forced by GLM_ORCHESTRATOR_MODEL\)$/m);
  assert.match(run('worker', ['--status']).stdout, /^orchestrator    glm-5\.3$/m);
  const r = runFull(['-p', 'x'], { GLM_ORCHESTRATOR_MODEL: 'glm-7' });
  assert.strictEqual(r.childEnv.ANTHROPIC_MODEL, 'glm-7');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-7');
});
test('a cc-router.json with glm_model=glm-5.3-flash and no orchestrator key still yields orchestrator glm-5.3; explicit values win', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-conf-'));
  const conf = path.join(dir, 'cc-router.json');
  fs.writeFileSync(conf, JSON.stringify({ glm_model: 'glm-5.3-flash', glm_fast_model: 'glm-x-fast' }));
  const s = run('worker', ['--status'], { CC_ROUTER_CONFIG: conf });
  assert.match(s.stdout, /^orchestrator    glm-5\.3$/m);
  assert.match(s.stdout, /^glm fast model  glm-x-fast$/m);
  const r = runFull(['-p', 'x', '--model', 'haiku'], { CC_ROUTER_CONFIG: conf });
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3');
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-x-fast');
});
test('worker --usage counts glm-5.3-flash and glm-5.3 both in the GLM share', () => {
  const sb0 = run('worker', ['--status']);
  const pj = path.join(sb0.dir, 'projects', 'p'); fs.mkdirSync(pj, { recursive: true });
  const rec = (model, id) => JSON.stringify({ type: 'assistant', requestId: id, timestamp: new Date().toISOString(), message: { model, usage: { output_tokens: 100 } } });
  fs.writeFileSync(path.join(pj, 'x.jsonl'), [rec('glm-5.3-flash', 'a'), rec('glm-5.3', 'b')].join('\n'));
  const r = run('worker', ['--usage', '1h', '--json'], { CC_PROJECTS_DIR: path.join(sb0.dir, 'projects') });
  assert.strictEqual(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.requests, 2);
  assert.strictEqual(j.glm_share_pct, 100);
  assert.strictEqual(j.models['glm-5.3-flash'].reqs, 1);
  assert.strictEqual(j.models['glm-5.3'].reqs, 1);
});

// --- entry split: provider claude, CC_WORKER_MODE=glm + BAJZI_SPLIT=1; on Linux with bwrap + socat on PATH
// an OS sandbox through a prepended --settings file (spec §6.2). Platform injected via CC_ROUTER_PLATFORM,
// the tools via PATH, the home (settings file, installed_plugins.json) via HOME/USERPROFILE. ---
const crypto = require('node:crypto');
const SPLIT_FAKE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-fake-')), 'fake-split.js');
fs.writeFileSync(SPLIT_FAKE, 'const out = {}; for (const k of ["CC_WORKER_MODE", "BAJZI_SPLIT", "BAJZI_SANDBOX", "BAJZI_SESSION_LEVEL", "ANTHROPIC_BASE_URL"]) if (process.env[k] !== undefined) out[k] = process.env[k];\n' +
  'process.stdout.write("FAKE_CLAUDE " + JSON.stringify({ env: out, argv: process.argv.slice(2) }) + "\\n");\n');
const EXCL = ['glm *', 'git add *', 'git commit *'].flatMap(c => [c, 'rtk ' + c]);
// The probe seam: CC_BWRAP_CMD = JSON [cmd, ...leading args] replaces `bwrap` (a fake bwrap on PATH cannot run on win32). The fake records its argv
// to $BWRAP_LOG and fails with $BWRAP_FAIL as its stderr when that is set.
const BWRAP_FAKE = path.join(path.dirname(SPLIT_FAKE), 'fake-bwrap.js');
fs.writeFileSync(BWRAP_FAKE, 'if (process.env.BWRAP_LOG) require("fs").writeFileSync(process.env.BWRAP_LOG, JSON.stringify(process.argv.slice(2)));\n' +
  'if (process.env.BWRAP_FAIL) { process.stderr.write(process.env.BWRAP_FAIL + "\\n"); process.exit(1); }\n');
const NO_FC = 'split: bajzi plugin root not found - findings CLI stays sandboxed\n';
const fcCli = root => { fs.mkdirSync(path.join(root, 'lib'), { recursive: true }); fs.writeFileSync(path.join(root, 'lib', 'findings-cli.js'), ''); return root; };
const plugins = (home, obj) => { const p = path.join(home, '.claude', 'plugins'); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'installed_plugins.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
// A fake home with one installed bajzi (its lib/findings-cli.js exists), fake tools on PATH, a non-git project dir.
function splitCtx({ platform = 'linux', tools = ['bwrap', 'socat'], keepPath = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-bin-'));
  for (const t of tools) { fs.writeFileSync(path.join(bin, t), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, t), 0o755); }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-proj-'));
  const plug = fcCli(path.join(home, '.claude', 'plugins', 'cache', 'mk', 'bajzi', '1.0.0'));
  plugins(home, { version: 2, plugins: { 'bajzi@mk': [{ scope: 'user', installPath: plug, version: '1.0.0', lastUpdated: '2026-10-01T00:00:00.000Z' }] } });
  const env = { HOME: home, USERPROFILE: home, CC_ROUTER_PLATFORM: platform, CC_CLAUDE_PREFIX_ARGS: JSON.stringify([SPLIT_FAKE]),
    PATH: keepPath ? bin + path.delimiter + (process.env.PATH || '') : bin,   // keepPath: git stays reachable
    GIT_CEILING_DIRECTORIES: path.dirname(cwd), BAJZI_SANDBOX: '', BAJZI_SPLIT: '', CLAUDE_CONFIG_DIR: '', BWRAP_FAIL: '', BWRAP_LOG: '',
    CC_BWRAP_CMD: JSON.stringify([process.execPath, BWRAP_FAKE]) };
  return { home, cwd, plug, env };
}
const sbFile = (home, root) => path.join(home, '.claude', 'bajzi', 'sandbox', 'split-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 12) + '.json');
const fcPair = plug => ['node ' + plug + '/lib/findings-cli.js *', 'node "' + plug + '/lib/findings-cli.js" *'];
const conf = (root, fc) => ({ sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: EXCL.concat(fc),
  filesystem: { allowWrite: [...new Set([os.tmpdir(), '/tmp'])], denyWrite: [root] } } });
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('split on Linux with bwrap + socat: --settings <file> first, exact sandbox JSON, CC_WORKER_MODE=glm, BAJZI_SPLIT=1, BAJZI_SANDBOX=1', () => {
  const c = splitCtx();
  const r = run('split', ['-p', 'x'], Object.assign(c.env, { CC_WORKER_MODE: 'claude' }), { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  const file = sbFile(c.home, c.cwd);
  assert.deepStrictEqual(r.childArgv, ['--settings', file, '-p', 'x']);
  const j = readJson(file);
  assert.deepStrictEqual(j, conf(c.cwd, fcPair(c.plug)));
  assert.ok(!j.sandbox.filesystem.denyWrite.some(p => p.includes('*')), 'no globs in denyWrite');
  assert.deepStrictEqual(r.childEnv, { CC_WORKER_MODE: 'glm', BAJZI_SPLIT: '1', BAJZI_SANDBOX: '1' });   // inherited claude overridden; no z.ai URL
  assert.strictEqual(r.stderr, '');
  assert.match(lastLog(r), / entry=split provider=claude asked=- model=\(session default\) headless split sandbox=yes cwd=/);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);   // no temp file left behind
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});
test('split: the project root is the git toplevel of cwd; an existing settings file is replaced (mode 600)', () => {
  const c = splitCtx();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-repo-'));
  assert.strictEqual(spawnSync('git', ['init', '-q', repo]).status, 0);
  const sub = path.join(repo, 'src'); fs.mkdirSync(sub);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: sub, encoding: 'utf8' }).stdout.trim();
  const file = sbFile(c.home, top);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'junk', { mode: 0o644 });
  const r = run('split', ['-p', 'x'], c.env, { cwd: sub });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.childArgv.slice(0, 2), ['--settings', file]);
  assert.deepStrictEqual(readJson(file), conf(top, fcPair(c.plug)));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});
test('split on Linux without bwrap or without socat: no --settings, no BAJZI_SANDBOX (an inherited one dropped), one stderr line', () => {
  for (const tools of [['socat'], ['bwrap'], []]) {
    const c = splitCtx({ tools, keepPath: false });
    const r = run('split', ['-p', 'x'], Object.assign(c.env, { BAJZI_SANDBOX: '1' }), { cwd: c.cwd });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(r.childArgv, ['-p', 'x'], tools.join());
    assert.deepStrictEqual(r.childEnv, { CC_WORKER_MODE: 'glm', BAJZI_SPLIT: '1' });
    assert.strictEqual(r.stderr, 'split: no OS sandbox (bubblewrap/socat missing) - Windows-tier guard only\n');
    assert.ok(!fs.existsSync(path.join(c.home, '.claude', 'bajzi', 'sandbox')));
    assert.match(lastLog(r), / entry=split provider=claude .* split sandbox=no cwd=/);
  }
});
test('split on win32 or darwin (bwrap + socat on PATH): no sandbox, the platform named', () => {
  for (const platform of ['win32', 'darwin']) {
    const c = splitCtx({ platform });
    const r = run('split', ['-p', 'x'], Object.assign(c.env, { BAJZI_SANDBOX: '1' }), { cwd: c.cwd });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(r.childArgv, ['-p', 'x']);
    assert.deepStrictEqual(r.childEnv, { CC_WORKER_MODE: 'glm', BAJZI_SPLIT: '1' });
    assert.strictEqual(r.stderr, 'split: no OS sandbox on ' + platform + ' - Windows-tier guard only\n');
    assert.ok(!fs.existsSync(path.join(c.home, '.claude', 'bajzi', 'sandbox')));
    assert.match(lastLog(r), / split sandbox=no cwd=/);
  }
});
test('split refuses a caller --settings / --settings=<f> with exit 64 and starts nothing', () => {
  for (const platform of ['linux', 'win32']) {
    for (const a of [['--settings', 'mine.json'], ['--settings=mine.json']]) {
      const c = splitCtx({ platform });
      const r = run('split', ['-p', 'x', ...a], c.env, { cwd: c.cwd });
      assert.strictEqual(r.code, 64, platform + ' ' + a.join(' '));
      assert.match(r.stderr, /^\[split\] .*--settings/);
      assert.strictEqual(r.childEnv, null);
      assert.ok(!fs.existsSync(path.join(c.home, '.claude', 'bajzi')));
    }
  }
});
test('split is never refused in the Z.ai peak window: the main session is Claude', () => {
  const c = splitCtx();
  const r = run('split', ['-p', 'x'], Object.assign(c.env, peakEnv('2026-09-23T07:00:00Z')), { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.ANTHROPIC_BASE_URL, undefined);
  assert.strictEqual(r.childEnv.BAJZI_SANDBOX, '1');
});
test('split: an unwritable sandbox dir exits 73 and starts nothing (no unsandboxed fallback)', () => {
  const c = splitCtx();
  fs.mkdirSync(path.join(c.home, '.claude', 'bajzi'), { recursive: true });
  fs.writeFileSync(path.join(c.home, '.claude', 'bajzi', 'sandbox'), 'a file, so mkdir fails');
  const r = run('split', ['-p', 'x'], c.env, { cwd: c.cwd });
  assert.strictEqual(r.code, 73);
  assert.match(r.stderr, /cannot write/);
  assert.strictEqual(r.childEnv, null);
});
test('split: the findings CLI pair comes from the newest bajzi@<marketplace> entry, never another plugin', () => {
  const c = splitCtx();
  const cache = path.join(c.home, '.claude', 'plugins', 'cache');
  const [old, newest, mid, infra] = ['old/bajzi/0.9', 'mk/bajzi/2.0', 'mk/bajzi/1.5', 'mk/bajzi-infra/9.0'].map(p => fcCli(path.join(cache, p)));
  plugins(c.home, { version: 2, plugins: {
    'bajzi-infra@mk': [{ installPath: infra, lastUpdated: '2026-12-01T00:00:00.000Z' }],
    'bajzi@mk': [{ installPath: mid, lastUpdated: '2026-09-01T00:00:00.000Z' }, { installPath: newest, lastUpdated: '2026-10-01T00:00:00.000Z' }],
    'bajzi@old': [{ installPath: old, lastUpdated: '2026-01-01T00:00:00.000Z' }] } });   // newest is neither first nor last
  const r = run('split', ['-p', 'x'], c.env, { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.deepStrictEqual(readJson(sbFile(c.home, c.cwd)).sandbox.excludedCommands, EXCL.concat(fcPair(newest)));
});
test('split: an unusable bajzi root gives NO findings CLI entry and one stderr line; the sandbox still starts', () => {
  const cases = {
    'no installed_plugins.json': c => fs.rmSync(path.join(c.home, '.claude', 'plugins', 'installed_plugins.json')),
    'bad JSON': c => plugins(c.home, '{not json'),
    'no bajzi@ key': c => plugins(c.home, { version: 2, plugins: { 'bajzi-infra@mk': [{ installPath: c.plug }] } }),
    'relative installPath': c => { fcCli(path.join(c.cwd, 'rel', 'bajzi')); plugins(c.home, { version: 2, plugins: { 'bajzi@mk': [{ installPath: 'rel/bajzi' }] } }); },
    'a .. segment': c => { fs.mkdirSync(path.join(c.plug, '..', 'x')); plugins(c.home, { version: 2, plugins: { 'bajzi@mk': [{ installPath: path.join(path.dirname(c.plug), 'x') + '/../1.0.0' }] } }); },
    'findings-cli.js missing': c => fs.rmSync(path.join(c.plug, 'lib', 'findings-cli.js')),
    'the newest entry is unusable, an older one is not': c => plugins(c.home, { version: 2, plugins: { 'bajzi@mk': [
      { installPath: c.plug, lastUpdated: '2026-01-01T00:00:00.000Z' }, { installPath: path.join(c.home, 'gone'), lastUpdated: '2026-10-01T00:00:00.000Z' }] } }),
  };
  if (process.platform !== 'win32') cases['a * in the root'] = c => {   // a literal * dir exists, so only the * rule refuses it
    const star = fcCli(path.join(path.dirname(c.plug), '1.*'));
    plugins(c.home, { version: 2, plugins: { 'bajzi@mk': [{ installPath: star }] } });
  };
  for (const [name, setup] of Object.entries(cases)) {
    const c = splitCtx();
    setup(c);
    const r = run('split', ['-p', 'x'], c.env, { cwd: c.cwd });
    assert.strictEqual(r.code, 0, name + ': ' + r.stderr);
    assert.strictEqual(r.stderr, NO_FC, name);
    assert.strictEqual(r.childArgv[0], '--settings', name);
    assert.strictEqual(r.childEnv.BAJZI_SANDBOX, '1', name);
    assert.deepStrictEqual(readJson(sbFile(c.home, c.cwd)), conf(c.cwd, []), name);
  }
});
test('split: excludedCommands hold only glm, git add, git commit (plain and rtk) and the findings CLI pair: no fetch/push/switch/checkout/gh', () => {
  const c = splitCtx();
  const r = run('split', ['-p', 'x'], c.env, { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  const ex = readJson(sbFile(c.home, c.cwd)).sandbox.excludedCommands;
  assert.deepStrictEqual(ex, ['glm *', 'rtk glm *', 'git add *', 'rtk git add *', 'git commit *', 'rtk git commit *'].concat(fcPair(c.plug)));
  for (const e of ex) assert.ok(!/^(?:rtk )?(?:gh|git (?:fetch|push|switch|checkout|merge|pull|clone))\b/.test(e), e);
});
test('split: a bwrap that cannot create a namespace -> no --settings, no BAJZI_SANDBOX, one stderr line naming the probe; the probe is the exact bwrap command', () => {
  const c = splitCtx();
  const log = path.join(c.home, 'bwrap-argv.json');
  const r = run('split', ['-p', 'x'], Object.assign(c.env, { BAJZI_SANDBOX: '1', BWRAP_FAIL: 'bwrap: setting up uid map: Permission denied', BWRAP_LOG: log }), { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.childArgv, ['-p', 'x']);
  assert.deepStrictEqual(r.childEnv, { CC_WORKER_MODE: 'glm', BAJZI_SPLIT: '1' });
  assert.strictEqual(r.stderr, 'split: bwrap cannot create a namespace (bwrap: setting up uid map: Permission denied) - on Ubuntu add an AppArmor profile for /usr/bin/bwrap; guard tier only\n');
  assert.ok(!fs.existsSync(path.join(c.home, '.claude', 'bajzi', 'sandbox')));
  assert.match(lastLog(r), / split sandbox=no cwd=/);
  assert.deepStrictEqual(readJson(log), ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true']);
});
test('split: a bwrap probe that cannot even start is a failed probe too', () => {
  const c = splitCtx();
  const r = run('split', ['-p', 'x'], Object.assign(c.env, { CC_BWRAP_CMD: JSON.stringify([path.join(c.home, 'no-such-bwrap')]) }), { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.childEnv.BAJZI_SANDBOX, undefined);
  assert.match(r.stderr, /^split: bwrap cannot create a namespace \(.+\) - on Ubuntu add an AppArmor profile for \/usr\/bin\/bwrap; guard tier only\n$/);
});
test('split: the bajzi root honours scope/projectPath and CLAUDE_CONFIG_DIR', () => {
  const c = splitCtx();
  const cache = path.join(c.home, '.claude', 'plugins', 'cache');
  const [user, other, mine] = ['mk/bajzi/1.0', 'mk/bajzi/9.0', 'mk/bajzi/8.0'].map(p => fcCli(path.join(cache, p)));
  const elsewhere = path.join(c.home, 'elsewhere');
  plugins(c.home, { version: 2, plugins: { 'bajzi@mk': [
    { scope: 'user', installPath: user, lastUpdated: '2026-01-01T00:00:00.000Z' },
    { scope: 'project', projectPath: elsewhere, installPath: other, lastUpdated: '2026-10-01T00:00:00.000Z' },
    { scope: 'local', projectPath: elsewhere, installPath: other, lastUpdated: '2026-10-02T00:00:00.000Z' }] } });
  let r = run('split', ['-p', 'x'], c.env, { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(readJson(sbFile(c.home, c.cwd)).sandbox.excludedCommands.slice(-2), fcPair(user));   // another project's entry is never loaded here
  plugins(c.home, { version: 2, plugins: { 'bajzi@mk': [
    { scope: 'user', installPath: user, lastUpdated: '2026-01-01T00:00:00.000Z' },
    { scope: 'project', projectPath: c.cwd, installPath: mine, lastUpdated: '2026-10-01T00:00:00.000Z' }] } });
  r = run('split', ['-p', 'x'], c.env, { cwd: c.cwd });
  assert.deepStrictEqual(readJson(sbFile(c.home, c.cwd)).sandbox.excludedCommands.slice(-2), fcPair(mine));   // this project's entry is
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-cfg-'));
  const viaCfg = fcCli(path.join(cfg, 'plugins', 'cache', 'mk', 'bajzi', '3.0'));
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'bajzi@mk': [{ scope: 'user', installPath: viaCfg }] } }));
  r = run('split', ['-p', 'x'], Object.assign(c.env, { CLAUDE_CONFIG_DIR: cfg }), { cwd: c.cwd });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(readJson(sbFile(c.home, c.cwd)).sandbox.excludedCommands.slice(-2), fcPair(viaCfg));
});
