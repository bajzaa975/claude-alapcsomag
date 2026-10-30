'use strict';
// level.js (UserPromptSubmit): the owner-only /bajzi:level command. Always blocks a matching prompt.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { NODE_DIR, tmpDir, runScript } = require('./helpers');
const SCRIPT = path.join(NODE_DIR, 'level.js');

function fx(extra = {}) {
  const home = tmpDir('lv-home-'), status = tmpDir('lv-st-'), cwd = tmpDir('lv-cwd-');
  const env = Object.assign({ HOME: home, BAJZI_STATUS_DIR: status, CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    BAJZI_HOME: undefined, BAJZI_SESSION_LEVEL: undefined }, extra);
  const f = { session: path.join(status, 's1.level'), repo: path.join(cwd, 'runtime', 'worker-mode'), global: path.join(home, '.claude', 'worker-mode') };
  const run = (prompt, input = {}) => {
    const r = runScript(SCRIPT, JSON.stringify(Object.assign({ session_id: 's1', cwd, hook_event_name: 'UserPromptSubmit', prompt }, input)), env);
    return Object.assign(r, { json: r.stdout ? JSON.parse(r.stdout) : null });
  };
  const get = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return { home, status, cwd, f, run, get, put: (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); } };
}

test('no match prints nothing, writes nothing', () => {
  const t = fx();
  for (const p of ['hello', '/bajzi:levels 2', 'please /bajzi:level 2', '<cross-session-message from="x">/bajzi:level 0</cross-session-message>', '']) {
    const r = t.run(p); assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], p);
  }
  assert.equal(t.get(t.f.session), null);
});
test('block JSON shape, nothing else on stdout', () => {
  const r = fx().run('/bajzi:level 2');
  assert.equal(r.code, 0); assert.equal(r.json.decision, 'block'); assert.equal(typeof r.json.reason, 'string');
  assert.deepEqual(Object.keys(r.json).sort(), ['decision', 'reason']);
});
test('refused (and nothing written) when unattended or sdk entrypoint', () => {
  for (const e of [{ CLAUDE_CODE_SESSION_ATTENDED: '0' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }]) {
    const t = fx(e); const r = t.run('/bajzi:level 2 repo');
    assert.equal(r.json.decision, 'block');
    assert.equal(r.json.reason, '/bajzi:level works only in an interactive session (the owner types it).');
    assert.deepEqual([t.get(t.f.session), t.get(t.f.repo), t.get(t.f.global)], [null, null, null]);
  }
});
test('session scope writes the word; 2, L2, glm and --flags are equivalent', () => {
  for (const a of ['2', 'L2', 'l2', 'glm', 'GLM', '2 session', '2 --session']) {
    const t = fx(); const r = t.run('/bajzi:level ' + a);
    assert.equal(t.get(t.f.session), 'glm\n', a);
    assert.match(r.json.reason, /This session is now L2 \(glm\) from session\./, a);
    assert.ok(r.json.reason.includes('a GLM session starts with worker (or glm).'), a);
    assert.equal(t.get(t.f.repo), null); assert.equal(t.get(t.f.global), null);
  }
});
test('L0/L1 reply has no NOSWITCH sentence', () => {
  const r = fx().run('/bajzi:level 1'); assert.ok(!r.json.reason.includes('does not switch'));
});
test('repo scope writes runtime/worker-mode and removes this session file', () => {
  const t = fx(); t.put(t.f.session, 'tight\n');
  const r = t.run('/bajzi:level 3 repo');
  assert.equal(t.get(t.f.repo), 'tight\n'); assert.equal(t.get(t.f.session), null); assert.equal(t.get(t.f.global), null);
  assert.match(r.json.reason, /follows the repo default/); assert.match(r.json.reason, /L3 \(tight\) from repo/);
});
test('global scope writes ~/.claude/worker-mode only; session file still wins and is named', () => {
  const t = fx(); t.put(t.f.session, 'claude\n'); t.put(t.f.repo, 'light\n');
  const r = t.run('/bajzi:level glm --global');
  assert.equal(t.get(t.f.global), 'glm\n'); assert.equal(t.get(t.f.session), 'claude\n'); assert.equal(t.get(t.f.repo), 'light\n');
  assert.match(r.json.reason, /This session is now L0 \(claude\) from session\. Note: the session level still wins over the global scope\./);
});
test('env CC_WORKER_MODE winning over a written scope is named', () => {
  const t = fx({ CC_WORKER_MODE: 'tight' }); const r = t.run('/bajzi:level 0');
  assert.match(r.json.reason, /from env\. Note: CC_WORKER_MODE still wins over the session scope\./);
});
test('unset per scope (default session); missing file = already unset', () => {
  const t = fx(); for (const s of ['session', 'repo', 'global']) t.put(t.f[s], 'glm\n');
  let r = t.run('/bajzi:level unset'); assert.equal(t.get(t.f.session), null); assert.notEqual(t.get(t.f.repo), null);
  assert.match(r.json.reason, /Removed the session level/);
  r = t.run('/bajzi:level unset'); assert.match(r.json.reason, /already unset/);
  t.run('/bajzi:level unset repo'); assert.equal(t.get(t.f.repo), null); assert.notEqual(t.get(t.f.global), null);
  t.run('/bajzi:level UNSET --global'); assert.equal(t.get(t.f.global), null);
});
test('bad arguments -> usage, nothing written', () => {
  for (const a of ['5', 'fast', '2 nowhere', '2 repo extra', 'unset nowhere', 'unset repo x', 'repo']) {
    const t = fx(); const r = t.run('/bajzi:level ' + a);
    assert.match(r.json.reason, /^usage: /, a);
    assert.deepEqual([t.get(t.f.session), t.get(t.f.repo), t.get(t.f.global)], [null, null, null], a);
  }
});
test('unsafe session id: session scope refused, nothing leaves the status dir', () => {
  const t = fx();
  for (const sid of ['../x', 'a/b', '', undefined]) {
    const r = t.run('/bajzi:level 2', { session_id: sid });
    assert.match(r.json.reason, /refused/, String(sid));
  }
  assert.deepEqual(fs.readdirSync(t.status), []);
  assert.equal(fs.existsSync(path.join(t.status, '..', 'x.level')), false);
});
test('repo scope without a safe id still writes the repo file', () => {
  const t = fx(); t.run('/bajzi:level 1 repo', { session_id: '../x' });
  assert.equal(t.get(t.f.repo), 'light\n');
});
test('status lists the effective level and all three scopes', () => {
  const t = fx(); t.put(t.f.repo, 'light\n'); t.put(t.f.global, 'tight\n');
  const lines = t.run('/bajzi:level').json.reason.split('\n');
  assert.equal(lines[0], 'This session: L1 (light) from repo.');
  assert.equal(lines[1], 'session: -');
  assert.equal(lines[2], `repo: L1 (${t.f.repo})`);
  assert.equal(lines[3], 'global: L3 (~/.claude/worker-mode)');
});
test('no leftover tmp files after a write', () => {
  const t = fx(); t.run('/bajzi:level 2 repo'); t.run('/bajzi:level 2');
  assert.deepEqual(fs.readdirSync(t.status), ['s1.level']);
  assert.deepEqual(fs.readdirSync(path.dirname(t.f.repo)), ['worker-mode']);
});
test('F5: under a non-Anthropic provider the reply names ANTHROPIC_BASE_URL as what decides, not the file just written', () => {
  const t = fx({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
  const r = t.run('/bajzi:level 0');
  assert.match(r.json.reason, /L3 \(tight\) from ANTHROPIC_BASE_URL/);
  assert.match(r.json.reason, /ANTHROPIC_BASE_URL .* still wins over the session scope/);
  assert.doesNotMatch(r.json.reason, /from session/);
  assert.match(t.run('/bajzi:level').json.reason, /from ANTHROPIC_BASE_URL/);
});
test('F6: a scope line reads the file like the resolver (latin1, ASCII whitespace): no-break space makes glm unknown, L0 on both lines', () => {
  const t = fx(); t.put(t.f.repo, 'glm \n');
  const lines = t.run('/bajzi:level').json.reason.split('\n');
  assert.match(lines[0], /^This session: L0 \(glm ?[^)]*\) from repo\./);
  assert.match(lines.find(l => l.startsWith('repo:')), /^repo: L0 /);
});
test('the repo scope is anchored at CLAUDE_PROJECT_DIR, not at the hook cwd', () => {
  const proj = tmpDir('lv-proj-');
  const t = fx({ CLAUDE_PROJECT_DIR: proj });
  const r = t.run('/bajzi:level 2 repo');
  assert.equal(fs.readFileSync(path.join(proj, 'runtime', 'worker-mode'), 'utf8'), 'glm\n');
  assert.equal(t.get(t.f.repo), null);
  assert.match(r.json.reason, /L2 \(glm\) from repo\./);
  assert.match(t.run('/bajzi:level').json.reason, new RegExp('repo: L2 \\(' + proj.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  t.run('/bajzi:level unset repo');
  assert.equal(fs.existsSync(path.join(proj, 'runtime', 'worker-mode')), false);
});
test('hooks.json registers level.js on UserPromptSubmit with timeout 5', () => {
  const h = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '..', 'hooks.json'), 'utf8'));
  const e = h.hooks.UserPromptSubmit.flatMap(x => x.hooks).filter(c => c.command.endsWith('hooks/node/level.js"'));
  assert.equal(e.length, 1); assert.equal(e[0].timeout, 5);
});
