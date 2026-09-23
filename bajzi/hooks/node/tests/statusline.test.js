'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_DIR, tmpDir, runScript, p95 } = require('./helpers');
const parts = require('../lib/status-parts');
const { render, usedPct } = require('../statusline');

const SCRIPT = path.join(NODE_DIR, 'statusline.js');
const NIGHT = Date.UTC(2026, 8, 23, 0, 0);          // 6 h before the peak window: no peak part
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function gitRepo(branch) {
  const dir = tmpDir('bajzi-repo-');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', '-C', dir, ...a], { stdio: 'ignore' });
  g('init');
  g('checkout', '-b', branch);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('commit', '-m', 'init');
  return dir;
}

function fixtureRepo() {
  const dir = gitRepo('feat/x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');          // tracked change = dirty
  fs.mkdirSync(path.join(dir, 'runtime', 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime', 'handoff', 'feat-x.md'),
    '# HANDOFF\nUpdated: 2026-09-23 10:00 \u00b7 Task: status line port\n');
  fs.mkdirSync(path.join(dir, 'runtime', 'review-queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime', 'review-queue', 'SPRINT-1.md'), '# Review queue: SPRINT-1\nstatus: open\n');
  fs.writeFileSync(path.join(dir, 'runtime', 'review-queue', 'SPRINT-2.md'), '# Review queue: SPRINT-2\nstatus: clean\n');
  return dir;
}

const input = (cwd, extra = {}) => Object.assign({
  session_id: 's1', model: { display_name: 'Opus 5.5' }, workspace: { current_dir: cwd },
  context_window: { remaining_percentage: 58 },
}, extra);

test('exact line for a full fixture (ANSI off)', () => {
  const cwd = fixtureRepo();
  const line = render(input(cwd), { env: {}, home: tmpDir('bajzi-h-'), nowMs: NIGHT, color: false });
  assert.strictEqual(line, 'Opus 5.5 \u00b7 L0 \u00b7 feat/x* \u00b7 status line port \u00b7 \u2593\u2593\u2593\u2593\u2591\u2591\u2591\u2591\u2591\u2591 42% \u00b7 Q1');
});

test('usedPct = round(100 - remaining_percentage), clamped; missing -> null', () => {
  assert.strictEqual(usedPct({ context_window: { remaining_percentage: 58 } }), 42);
  assert.strictEqual(usedPct({ context_window: { remaining_percentage: 49.6 } }), 50);
  assert.strictEqual(usedPct({ context_window: { remaining_percentage: -3 } }), 100);
  assert.strictEqual(usedPct({ context_window: {} }), null);
  assert.strictEqual(usedPct({}), null);
  assert.strictEqual(usedPct({ context_window: { remaining_percentage: '40' } }), null);
});

test('colours: green < 40, yellow 40-49, red >= 50', () => {
  const home = tmpDir('bajzi-h-');
  const cwd = tmpDir('bajzi-nr-');
  const col = rem => render({ context_window: { remaining_percentage: rem }, workspace: { current_dir: cwd } },
    { env: {}, home, nowMs: NIGHT, color: true });
  assert.ok(col(61).includes('\x1b[32m'));   // 39 used
  assert.ok(col(60).includes('\x1b[33m'));   // 40 used
  assert.ok(col(51).includes('\x1b[33m'));   // 49 used
  assert.ok(col(50).includes('\x1b[31m'));   // 50 used
});

test('GLM share is shown only at L1-L3, from a fresh cache', () => {
  const home = tmpDir('bajzi-h-');
  fs.mkdirSync(path.join(home, '.claude', 'bajzi'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'bajzi', 'glm-share.json'), JSON.stringify({ ts: NIGHT - 1000, pct: 64 }));
  const cwd = tmpDir('bajzi-nr-');
  const l2 = strip(render({ workspace: { current_dir: cwd } }, { env: { CC_WORKER_MODE: 'glm' }, home, nowMs: NIGHT }));
  assert.strictEqual(l2, 'L2 \u00b7 GLM 64%');
  const l0 = strip(render({ workspace: { current_dir: cwd } }, { env: {}, home, nowMs: NIGHT }));
  assert.strictEqual(l0, 'L0');
});

test('peak part: 2 h before and inside the window only', () => {
  const home = tmpDir('bajzi-h-');
  const cwd = tmpDir('bajzi-nr-');
  const r = now => strip(render({ workspace: { current_dir: cwd } }, { env: {}, home, nowMs: now }));
  assert.strictEqual(r(Date.UTC(2026, 8, 23, 3, 59)), 'L0');
  assert.strictEqual(r(Date.UTC(2026, 8, 23, 4, 55)), 'L0 \u00b7 peak in 1h 5m');
  assert.strictEqual(r(Date.UTC(2026, 8, 23, 7, 30)), 'L0 \u00b7 peak now, 2h 30m left');
});

test('handoffTask: newest file wins, truncated to 20 chars', () => {
  const cwd = tmpDir('bajzi-nr-');
  const dir = path.join(cwd, 'runtime', 'handoff');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.md'), 'Updated: x \u00b7 Task: old task\n');
  const past = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(dir, 'old.md'), past, past);
  fs.writeFileSync(path.join(dir, 'new.md'), 'Updated: x \u00b7 Task: A very long task description here\n');
  assert.strictEqual(parts.handoffTask(cwd), 'A very long task de\u2026');
  assert.strictEqual(parts.handoffTask(tmpDir('bajzi-nr-')), null);
});

test('parseGitStatus: branch, dirty, detached', () => {
  assert.deepStrictEqual(parts.parseGitStatus('# branch.oid abc\n# branch.head main\n'), { branch: 'main', dirty: false });
  assert.deepStrictEqual(parts.parseGitStatus('# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 a b a.txt\n'), { branch: 'main', dirty: true });
  assert.deepStrictEqual(parts.parseGitStatus('# branch.oid 1234567890\n# branch.head (detached)\n'), { branch: '1234567', dirty: false });
  assert.strictEqual(parts.parseGitStatus(''), null);
});

test('glmShare: no cache -> null and one refresh; lock suppresses a second refresh', () => {
  const home = tmpDir('bajzi-h-');
  let calls = 0;
  const refresh = () => { calls++; };
  assert.strictEqual(parts.glmShare({ nowMs: NIGHT, home, env: {}, refresh }), null);
  assert.strictEqual(parts.glmShare({ nowMs: NIGHT + 1000, home, env: {}, refresh }), null);
  assert.strictEqual(calls, 1);
});

test('glmShare: stale cache returns the old value and refreshes; fresh cache does not refresh', () => {
  const home = tmpDir('bajzi-h-');
  const cache = path.join(home, '.claude', 'bajzi', 'glm-share.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  let calls = 0;
  const refresh = () => { calls++; };
  fs.writeFileSync(cache, JSON.stringify({ ts: NIGHT - 400000, pct: 50 }));
  assert.strictEqual(parts.glmShare({ nowMs: NIGHT, home, env: {}, refresh }), 50);
  assert.strictEqual(calls, 1);
  fs.writeFileSync(cache, JSON.stringify({ ts: NIGHT - 1000, pct: 70 }));
  fs.rmSync(cache + '.lock', { force: true });
  assert.strictEqual(parts.glmShare({ nowMs: NIGHT, home, env: {}, refresh }), 70);
  assert.strictEqual(calls, 1);
});

test('refreshGlm reads glm_share_pct from the worker command; a failing command caches null', () => {
  const dir = tmpDir('bajzi-w-');
  const fake = path.join(dir, 'fake-worker.js');
  fs.writeFileSync(fake, 'process.stdout.write(JSON.stringify({ glm_share_pct: 71.6 }))');
  const cache = path.join(dir, 'glm-share.json');
  parts.refreshGlm(cache, Object.assign({}, process.env, { BAJZI_WORKER_CMD: `"${process.execPath}" "${fake}"` }));
  assert.strictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).pct, 72);
  const fresh = path.join(dir, 'glm-none.json');
  parts.refreshGlm(fresh, Object.assign({}, process.env, { BAJZI_WORKER_CMD: 'bajzi-no-such-worker-xyz' }));
  assert.strictEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')).pct, null);
});

test('M4: a failed refresh keeps the last good GLM value (never overwrites it with null)', () => {
  const dir = tmpDir('bajzi-w-');
  const cache = path.join(dir, 'glm-share.json');
  fs.writeFileSync(cache, JSON.stringify({ ts: 1000, pct: 72 }));
  fs.writeFileSync(path.join(dir, 'bad-worker.js'), 'process.stdout.write("not json")');
  parts.refreshGlm(cache, Object.assign({}, process.env, { BAJZI_WORKER_CMD: 'bajzi-no-such-worker-xyz' }));
  assert.strictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).pct, 72);
  parts.refreshGlm(cache, Object.assign({}, process.env, { BAJZI_WORKER_CMD: `"${process.execPath}" "${path.join(dir, 'bad-worker.js')}"` }));
  assert.strictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).pct, 72);
});

test('M3: the refresh lock is taken with wx -- a just-created (still empty) lock suppresses a refresh', () => {
  const home = tmpDir('bajzi-h-');
  const cache = parts.glmCachePath(home);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache + '.lock', '');                          // a concurrent writer mid-create
  let calls = 0;
  assert.strictEqual(parts.glmShare({ nowMs: Date.now(), home, env: {}, refresh: () => { calls++; } }), null);
  assert.strictEqual(calls, 0);
  fs.writeFileSync(cache + '.lock', String(Date.now() - 120000));  // expired lock is taken over once
  parts.glmShare({ nowMs: Date.now(), home, env: {}, refresh: () => { calls++; } });
  parts.glmShare({ nowMs: Date.now(), home, env: {}, refresh: () => { calls++; } });
  assert.strictEqual(calls, 1);
});

test('M3: 8 concurrent status lines start at most one refresh', () => {
  const home = tmpDir('bajzi-h-');
  const hits = path.join(home, 'hits.txt');
  const script = path.join(home, 'race.js');
  fs.writeFileSync(script, `const parts = require(${JSON.stringify(path.join(NODE_DIR, 'lib', 'status-parts.js'))});
const fs = require('node:fs');
const start = Number(process.argv[2]);
while (Date.now() < start) { /* align the racers */ }
parts.glmShare({ nowMs: Date.now(), home: ${JSON.stringify(home)}, env: {}, refresh: () => fs.appendFileSync(${JSON.stringify(hits)}, 'x') });
`);
  const { spawn } = require('node:child_process');
  const start = Date.now() + 700;
  const kids = [];
  for (let i = 0; i < 8; i++) kids.push(spawn(process.execPath, [script, String(start)], { stdio: 'ignore' }));
  return Promise.all(kids.map(k => new Promise(r => k.on('exit', r)))).then(() => {
    assert.strictEqual(fs.readFileSync(hits, 'utf8').length, 1);
  });
});

test('M1: a cached git-info entry that fails the schema is ignored and recomputed', () => {
  const cwd = gitRepo('feat/x');
  const now = Date.now();
  for (const info of [
    { branch: 'evil\x1b]0;pwned\x07', dirty: false },
    { branch: 'main\r\nfake', dirty: false },
    { branch: 42, dirty: false },
    { branch: 'main', dirty: 'yes' },
    { branch: '', dirty: false },
    'main',
    [1],
  ]) {
    fs.writeFileSync(parts.gitCachePath(cwd), JSON.stringify({ ts: now, info }));
    assert.deepStrictEqual(parts.gitInfo(cwd, now), { branch: 'feat/x', dirty: false }, JSON.stringify(info));
  }
  fs.writeFileSync(parts.gitCachePath(cwd), JSON.stringify({ ts: now, info: { branch: 'cached', dirty: true } }));
  assert.deepStrictEqual(parts.gitInfo(cwd, now), { branch: 'cached', dirty: true });   // a valid entry is still used
});

test('M1: control and ESC characters are stripped from branch text', () => {
  assert.deepStrictEqual(parts.parseGitStatus('# branch.oid abc\n# branch.head ma\x1b[31min\x07\n'), { branch: 'ma[31min', dirty: false });
});

test('RF5: status line degrades to a clean single line', () => {
  const cwd = tmpDir('bajzi-nr-');                               // not a repo, no runtime/
  const stdin = JSON.stringify({ workspace: { current_dir: cwd } }); // no model, no context_window
  const r = runScript(SCRIPT, stdin, { CC_WORKER_MODE: 'glm', BAJZI_WORKER_CMD: 'bajzi-no-such-worker-xyz' }, { cwd });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  assert.match(strip(r.stdout), /^L2( \u00b7 peak [^\u00b7\n]+)?\n$/);
  const empty = runScript(SCRIPT, '', {}, { cwd });
  assert.strictEqual(empty.code, 0);
  assert.match(strip(empty.stdout), /^L0( \u00b7 peak [^\u00b7\n]+)?\n$/);
  const garbage = runScript(SCRIPT, 'not json', {}, { cwd });
  assert.strictEqual(garbage.code, 0);
  assert.strictEqual(garbage.stderr, '');
});

test('the status line writes the bridge for a safe session id only', () => {
  const cwd = tmpDir('bajzi-nr-');
  const ok = runScript(SCRIPT, JSON.stringify({ session_id: 'sess-1', context_window: { remaining_percentage: 45 }, workspace: { current_dir: cwd } }), {}, { cwd });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ok.tmp, 'bajzi-ctx-sess-1.json'), 'utf8')).used_pct, 55);
  const bad = runScript(SCRIPT, JSON.stringify({ session_id: '../evil', context_window: { remaining_percentage: 45 }, workspace: { current_dir: cwd } }), {}, { cwd });
  assert.deepStrictEqual(fs.readdirSync(bad.tmp).filter(n => n.startsWith('bajzi-ctx-')), []);
  assert.ok(!fs.existsSync(path.join(path.dirname(bad.tmp), 'bajzi-ctx-..', 'evil.json')));
});

test('p95 of 20 warm runs < 150 ms', () => {
  const cwd = fixtureRepo();
  const home = tmpDir('bajzi-h-');
  const tmp = tmpDir('bajzi-t-');
  const stdin = JSON.stringify(input(cwd));
  runScript(SCRIPT, stdin, { HOME: home, TMPDIR: tmp }, { cwd });   // warm the git cache
  const ms = [];
  for (let i = 0; i < 20; i++) ms.push(runScript(SCRIPT, stdin, { HOME: home, TMPDIR: tmp }, { cwd }).ms);
  assert.ok(p95(ms) < 150, `p95 ${p95(ms).toFixed(1)} ms`);
});
