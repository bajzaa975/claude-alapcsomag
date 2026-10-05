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
    BAJZI_STATUS_DIR: path.join(dir, 'sessions'),   // session level files land in the sandbox, never the real home
  });
  // The test process may run inside Claude Code: its session id must never reach the router unless a test sets it.
  for (const k of ['CC_WORKER_MODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'BAJZI_HOME', 'BAJZI_SESSION_LEVEL',
    'GLM_MODEL', 'GLM_FAST_MODEL', 'GLM_ORCHESTRATOR_MODEL']) delete env[k];
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
  assert.strictEqual(r.childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');   // DEFAULTS glm_fast_model
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
test('worker --set-model / --set-fast-model write their own key and leave the orchestrator default', () => {
  const a = run('worker', ['--set-model', 'glm-a']);
  assert.strictEqual(a.code, 0, a.stderr);
  const conf = path.join(a.dir, 'cc-router.json');
  assert.strictEqual(run('worker', ['--set-fast-model', 'glm-b'], { CC_ROUTER_CONFIG: conf }).code, 0);
  const c = JSON.parse(fs.readFileSync(conf, 'utf8'));
  assert.deepStrictEqual([c.glm_orchestrator_model, c.glm_model, c.glm_fast_model], ['glm-5.3', 'glm-a', 'glm-b']);
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
