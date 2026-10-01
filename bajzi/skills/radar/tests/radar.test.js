'use strict';
// bajzi radar: digest (counts only), run (report / last-error), notice, seen, install-task.
// tmp dirs only, no real claude, no network.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('../radar.js');

const RADAR = path.join(__dirname, '..', 'radar.js');
const SECRET = 'SECRET_TOKEN_9f8e7d';
const T = '2026-09-20T10:00:00.000Z';
const OLD = '2026-08-01T10:00:00.000Z';
const SINCE = new Date('2026-09-15T00:00:00Z');
const NOW = new Date('2026-10-01T09:00:00Z');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const jl = rows => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const setM = (p, d) => fs.utimesSync(p, d, d);

function fixture() {
  const root = tmp('bajzi-radar-');
  const projects = path.join(root, 'projects');
  const alpha = path.join(root, 'work', 'alpha');
  const base = { sessionId: 's1', cwd: alpha, timestamp: T };
  const asst = (id, model, block, usage) => ({ ...base, type: 'assistant', message: { id, model, role: 'assistant', content: [block], usage } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const res = (id, isErr, content) => ({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isErr, content }] } });
  const u1 = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
  write(path.join(projects, 'D--work-alpha', 's1.jsonl'), jl([
    { ...base, type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-args></command-args>' } },
    { ...base, type: 'user', message: { role: 'user', content: 'please use ' + SECRET } },
    asst('m1', 'claude-opus-5-5', use('tu1', 'Bash', { command: 'echo ' + SECRET }), u1),
    asst('m1', 'claude-opus-5-5', use('tu2', 'Skill', { skill: 'bajzi:handoff' }), u1),
    res('tu1', true, 'Permission to use Bash has been denied. ' + SECRET),
    res('tu2', false, 'ok'),
    asst('m2', 'claude-sonnet-5', use('tu3', 'Agent', { subagent_type: 'bajzi:reviewer', model: 'opus', prompt: SECRET }), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }),
    asst('m3', 'claude-sonnet-5', use('tu4', 'Task', { subagent_type: 'Explore', prompt: 'x' }), {}),
    res('tu3', true, [{ type: 'text', text: "The user doesn't want to proceed with this tool use. " + SECRET }]),
    asst('m4', 'claude-sonnet-5', use('tu6', 'Skill', { skill: 'leak ' + SECRET + ' now' }), {}),
    { ...base, type: 'system', subtype: 'compact_boundary' },
    { ...base, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary ' + SECRET } },
    { ...base, timestamp: OLD, type: 'assistant', message: { id: 'm0', model: 'claude-old-1', content: [use('tu0', 'Read', { file_path: '/x' })], usage: u1 } },
    '{not json',
  ]));
  write(path.join(projects, 'C--beta', 's2.jsonl'), jl([
    { sessionId: 's3', cwd: '/', timestamp: T, type: 'user', message: { role: 'user', content: 'root cwd' } },
    { sessionId: 's2', cwd: 'C:\\Users\\someone\\beta', timestamp: T, type: 'user', message: { role: 'user', content: 'hi' } },
  ]));
  const sub = path.join(projects, 'D--work-alpha', 's1', 'subagents', 'agent-1.jsonl');
  write(sub, jl([asst('m5', 'claude-haiku-4-5', use('tu5', 'Grep', { pattern: SECRET }), {})]));
  write(path.join(alpha, 'runtime', 'DAY-RUN.log'), [
    '2026-09-20T10:00:00Z implement model=sonnet rounds=1 result=pass',
    '2026-09-21T10:00+02:00 implement model=sonnet rounds=2 result=fail slice=x  # note ' + SECRET,
    '2026-09-22T10:00:00 review model=opus rounds=1 result=pass extra-tail',
    '2026-09-23T10:00:00Z review(s157-s1) model=opus rounds=2 result=pass(CLEAN)',
    '2026-08-01T10:00:00Z implement model=sonnet rounds=5 result=pass',
    'this line is broken',
    '',
  ].join('\n'));
  return { root, projects, alpha, sub };
}

const has = (out, line) => assert.ok(out.split('\n').includes(line), 'missing line: ' + line + '\n---\n' + out);

test('digest counts sessions, models (deduped by message id), tools, skills, agents, errors, denials, commands, compactions', async () => {
  const f = fixture();
  const out = await R.digest({ projectsDir: f.projects, since: SINCE, now: NOW });
  has(out, '- alpha: 1');
  has(out, '- beta: 1');
  has(out, '- (other): 1');
  has(out, '- claude-opus-5-5: 1 msgs · in 10 · out 20 · cache_read 100 · cache_write 5');
  has(out, '- claude-sonnet-5: 3 msgs · in 1 · out 2 · cache_read 3 · cache_write 4');
  has(out, '- claude-haiku-4-5: 1 msgs · in 0 · out 0 · cache_read 0 · cache_write 0');
  for (const l of ['- Skill: 2', '- Bash: 1', '- Agent: 1', '- Task: 1', '- Grep: 1']) has(out, l);
  has(out, '- bajzi:handoff: 1');
  has(out, '- (other): 1');
  has(out, '- bajzi:reviewer: 1');
  has(out, '- Explore: 1');
  has(out, '- opus: 1');
  has(out, '- inherit: 1');
  assert.match(out, /### tool errors by tool\n- Agent: 1\n- Bash: 1\n/);
  assert.match(out, /### permission denials \(approximate\)\n- 2\n/);
  has(out, '- /clear: 1');
  assert.match(out, /### compactions\n- 1\n/);
  assert.match(out, /malformed lines: 1/);
  assert.doesNotMatch(out, /claude-old-1|- Read:/);
});

test('digest since filter: entry timestamps before since and files with mtime before since are skipped', async () => {
  const f = fixture();
  setM(f.sub, new Date('2026-09-01T00:00:00Z'));
  const out = await R.digest({ projectsDir: f.projects, since: SINCE, now: NOW });
  assert.doesNotMatch(out, /claude-haiku-4-5|- Grep:/);
  const later = await R.digest({ projectsDir: f.projects, since: new Date('2026-09-25T00:00:00Z'), now: NOW });
  assert.doesNotMatch(later, /- Bash:|- alpha:|claude-opus-5-5/);
});

test('digest NO-LEAK: a secret in user text, tool inputs, tool results and DAY-RUN tails never appears; no path but a basename', async () => {
  const f = fixture();
  const out = await R.digest({ projectsDir: f.projects, since: SINCE, now: NOW });
  assert.ok(!out.includes(SECRET), out);
  assert.ok(!out.includes(f.root), out);
  assert.ok(!out.includes('someone'), out);
  assert.doesNotMatch(out, /echo|please use|summary|extra-tail|slice=x|s157|CLEAN/);
});

test('digest DAY-RUN aggregation: count + rounds per task-class x model, results tally, malformed count, old lines skipped', async () => {
  const f = fixture();
  const out = await R.digest({ projectsDir: f.projects, since: SINCE, now: NOW });
  has(out, '- implement x sonnet: 2 runs · 3 rounds');
  has(out, '- review x opus: 2 runs · 3 rounds');
  has(out, '- results: fail 1 · pass 3');
  has(out, '- malformed lines: 1');
});

test('digest: a cwd basename failing LABEL is reported as (other)', async () => {
  const root = tmp('bajzi-radar-b-');
  write(path.join(root, 'p', 'a.jsonl'), jl([
    { sessionId: 's1', cwd: '/w/my project "x"=1', timestamp: T, type: 'user', message: { role: 'user', content: 'hi' } },
    { sessionId: 's2', cwd: '/w/ok-name', timestamp: T, type: 'user', message: { role: 'user', content: 'hi' } },
  ]));
  const out = await R.digest({ projectsDir: root, since: SINCE, now: NOW });
  has(out, '- (other): 1');
  has(out, '- ok-name: 1');
  assert.ok(!out.includes('my project'), out);
});

test('digest stays at most 150 lines on a wide fixture', async () => {
  const root = tmp('bajzi-radar-wide-');
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ sessionId: 's' + i, cwd: '/w/p' + i, timestamp: T, type: 'assistant',
      message: { id: 'id' + i, model: 'model-' + i, content: [{ type: 'tool_use', id: 't' + i, name: 'Tool' + i, input: { skill: 'sk' + i, subagent_type: 'ag' + i } }], usage: {} } });
    rows.push({ sessionId: 's' + i, cwd: '/w/p' + i, timestamp: T, type: 'user', message: { role: 'user', content: '<command-name>/c' + i + '</command-name>' } });
  }
  write(path.join(root, 'p', 'a.jsonl'), jl(rows));
  const out = await R.digest({ projectsDir: root, since: SINCE, now: NOW });
  assert.ok(out.split('\n').length <= 150, String(out.split('\n').length));
});

// ---------- run ----------

function runEnv() {
  const f = fixture();
  const home = path.join(f.root, 'home');
  const state = path.join(f.root, 'state');
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'bajzi@bajzi-plugins': [{ installPath: path.join(home, 'cache', 'bajzi', '1.11.0') }] } }));
  const calls = [];
  const envs = [];
  const exec = (bin, args, env) => {
    calls.push(args.join(' '));
    envs.push(env);
    if (args[0] === '--version') return { status: 0, stdout: '2.1.286 (Claude Code)\n', stderr: '' };
    if (args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: JSON.stringify([{ id: 'bajzi@bajzi-plugins', version: '1.11.0', enabled: true, installPath: path.join(home, 'cache', 'bajzi', '1.11.0') },
        { id: 'x@y', version: '0.1.0', enabled: false, installPath: path.join(home, 'cache', 'y', 'x', '0.1.0') }]), stderr: '' };
    }
    throw new Error('network down');
  };
  return { f, home, state, exec, calls, envs };
}
const okClaude = seen => (prompt, opts) => { seen.prompt = prompt; seen.opts = opts; return { code: 0, stdout: '\n# bajzi radar - 2026-10-01\n\nNothing worth changing.\n', stderr: '' }; };
const reports = state => { try { return fs.readdirSync(path.join(state, 'reports')).sort(); } catch { return []; } };

test('run writes the report on sentinel + exit 0, atomically, with -2 on a same-day rerun; pre-step failures are noted, not fatal', async () => {
  const e = runEnv();
  const seen = {};
  const r = await R.run({ state: e.state, now: NOW, claude: okClaude(seen), exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(reports(e.state), ['2026-10-01.md']);
  assert.match(fs.readFileSync(path.join(e.state, 'reports', '2026-10-01.md'), 'utf8'), /# bajzi radar - 2026-10-01/);
  assert.strictEqual(seen.opts.cwd, e.state);
  const p = seen.prompt;
  assert.ok(p.startsWith(fs.readFileSync(path.join(__dirname, '..', 'prompt.md'), 'utf8').trimEnd()));
  assert.match(p, /claude plugin marketplace update: FAILED \(network down\)/);
  assert.match(p, /2\.1\.286 \(Claude Code\)/);
  // every installed plugin carries its installPath (supply-chain hooks/.mcp.json diff, token cost Glob)
  assert.ok(p.includes('- bajzi@bajzi-plugins@1.11.0 installPath: ' + path.join(e.home, 'cache', 'bajzi', '1.11.0') + '\n'), p);
  assert.ok(p.includes('- x@y@0.1.0 (disabled) installPath: ' + path.join(e.home, 'cache', 'y', 'x', '0.1.0') + '\n'), p);
  assert.ok(p.includes(path.join(e.home, '.claude', 'plugins', 'installed_plugins.json')), p);
  assert.ok(p.includes(path.join(e.home, 'cache', 'bajzi', '1.11.0', 'skills', 'setup', 'manifest.json')));
  assert.ok(p.includes(path.join(e.home, '.claude', 'CLAUDE.md')) && p.includes(path.join(e.home, '.claude', 'RTK.md')));
  assert.ok(p.includes(path.join(e.home, '.claude', 'plugins', 'marketplaces', 'bajzi-plugins', 'docs', 'bajzi-package-spec.md')));
  assert.ok(p.includes(path.join(e.state, 'declined.md')));
  assert.match(p, /## Usage digest/);
  assert.match(p, /- alpha: 1/);
  assert.ok(!fs.existsSync(path.join(e.state, 'last-error.log')));
  const r2 = await R.run({ state: e.state, now: NOW, claude: okClaude({}), exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(reports(e.state), ['2026-10-01-2.md', '2026-10-01.md']);
});

test('run on exit != 0 writes last-error.log and no report', async () => {
  const e = runEnv();
  const claude = () => ({ code: 1, stdout: '# bajzi radar - 2026-10-01\npartial', stderr: Array.from({ length: 50 }, (_, i) => 'err' + i).join('\n') });
  const r = await R.run({ state: e.state, now: NOW, claude, exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(reports(e.state), []);
  const log = fs.readFileSync(path.join(e.state, 'last-error.log'), 'utf8');
  assert.match(log, /exit code: 1/);
  assert.match(log, /err49/);
  assert.doesNotMatch(log, /err9\n/);
  assert.match(log, /partial/);
});

test('run with exit 0 but no sentinel (or a throwing claude) writes last-error.log and no report', async () => {
  const e = runEnv();
  const r = await R.run({ state: e.state, now: NOW, claude: () => ({ code: 0, stdout: 'Here is the report\n# bajzi radar - x', stderr: '' }), exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(reports(e.state), []);
  assert.match(fs.readFileSync(path.join(e.state, 'last-error.log'), 'utf8'), /Here is the report/);
  const r2 = await R.run({ state: e.state, now: NOW, claude: () => { throw new Error('spawn ENOENT'); }, exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.strictEqual(r2.ok, false);
  assert.match(fs.readFileSync(path.join(e.state, 'last-error.log'), 'utf8'), /spawn ENOENT/);
  assert.deepStrictEqual(reports(e.state), []);
});

test('run derives since from the newest report mtime, else now - 14 days', async () => {
  const e = runEnv();
  const s0 = {};
  await R.run({ state: e.state, now: NOW, claude: p => { s0.p = p; return { code: 1, stdout: '', stderr: '' }; }, exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.match(s0.p, new RegExp('since: ' + new Date(NOW - 14 * 864e5).toISOString().replace(/\./g, '\\.')));
  const rd = path.join(e.state, 'reports');
  write(path.join(rd, '2026-09-01.md'), '# bajzi radar - 2026-09-01\n');
  write(path.join(rd, '2026-09-10.md'), '# bajzi radar - 2026-09-10\n');
  setM(path.join(rd, '2026-09-01.md'), new Date('2026-09-01T10:00:00Z'));
  setM(path.join(rd, '2026-09-10.md'), new Date('2026-09-22T12:00:00Z'));
  const s = {};
  await R.run({ state: e.state, now: NOW, claude: p => { s.p = p; return { code: 1, stdout: '', stderr: '' }; }, exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.match(s.p, /since: 2026-09-22T12:00:00\.000Z/);
  assert.match(s.p, /2026-09-10\.md/);
  // the digest window follows: alpha's entries (2026-09-20) are before since
  assert.doesNotMatch(s.p, /- alpha: 1/);
});

test('run: the next window starts where the previous digest window ended', async () => {
  const e = runEnv();
  const at = d => new Date(+NOW + d * 864e5);
  const go = (now, claude) => R.run({ state: e.state, now, claude, exec: e.exec, home: e.home, projectsDir: e.f.projects });
  assert.strictEqual((await go(NOW, okClaude({}))).ok, true);
  setM(path.join(e.state, 'reports', '2026-10-01.md'), new Date(+NOW + 40 * 60e3));
  const s = {};
  await go(at(14), okClaude(s));
  assert.match(s.prompt, /since: 2026-10-01T09:00:00\.000Z/);
  // a failed run does not advance the window
  await go(at(28), () => ({ code: 1, stdout: '', stderr: '' }));
  const s2 = {};
  await go(at(29), okClaude(s2));
  assert.match(s2.prompt, new RegExp('since: ' + at(14).toISOString().replace(/\./g, '\\.')));
});

test('run writes last-error.log when the report rename fails', async t => {
  const e = runEnv();
  t.mock.method(fs, 'renameSync', () => { throw new Error('EPERM: rename blocked'); });
  const r = await R.run({ state: e.state, now: NOW, claude: okClaude({}), exec: e.exec, home: e.home, projectsDir: e.f.projects });
  t.mock.restoreAll();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.path, path.join(e.state, 'last-error.log'));
  assert.match(fs.readFileSync(r.path, 'utf8'), /rename blocked/);
  assert.deepStrictEqual(reports(e.state), []);
});

test('run started from a glm/worker/ccr session spawns the session and pre-steps without the provider variables', async () => {
  const e = runEnv();
  const seen = {};
  const env = { KEEP_ME: '1', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'glm',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm', CLAUDE_CODE_SUBAGENT_MODEL: 'glm', CLAUDECODE: '1', CC_ROUTER_WORKER: '1' };
  const before = { ...env };
  await R.run({ state: e.state, now: NOW, claude: okClaude(seen), exec: e.exec, home: e.home, projectsDir: e.f.projects, env });
  assert.deepStrictEqual(env, before);
  assert.ok(e.envs.length >= 3);
  for (const x of [seen.opts.env, ...e.envs]) assert.deepStrictEqual(x, { KEEP_ME: '1' });
});

test('CLI run exits 1 and writes last-error.log when the claude binary fails (real spawn, no shell)', () => {
  const e = runEnv();
  const r = spawnSync(process.execPath, [RADAR, 'run'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: e.home, USERPROFILE: e.home, BAJZI_RADAR_HOME: e.state, BAJZI_RADAR_CLAUDE: process.execPath },
  });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(e.state, 'last-error.log')));
  assert.deepStrictEqual(reports(e.state), []);
});

const argsAfter = (a, flag) => { const i = a.indexOf(flag); assert.ok(i >= 0, flag); const out = []; for (let j = i + 1; j < a.length && !a[j].startsWith('-'); j++) out.push(a[j]); return out; };

test('claude args: --tools is exactly the five read-only tools; no write/exec/agent tool anywhere', () => {
  const a = R.claudeArgs();
  const RO = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
  const after = flag => argsAfter(a, flag);
  assert.deepStrictEqual(after('--tools'), RO);
  assert.deepStrictEqual(after('--allowedTools').filter(t => !t.startsWith('WebFetch(domain:')), ['Read', 'Glob', 'Grep', 'WebSearch']);
  for (const f of ['-p', '--strict-mcp-config', '--no-session-persistence']) assert.ok(a.includes(f), f);
  assert.deepStrictEqual(after('--model'), ['opus']);
  assert.deepStrictEqual(after('--permission-mode'), ['dontAsk']);
  for (const t of ['Bash', 'Edit', 'Write', 'Agent', 'Task', 'PowerShell', 'Skill', 'NotebookEdit']) assert.ok(!a.includes(t), t);
});

test('claude args: WebFetch is limited to the pinned source and GitHub API hosts', () => {
  const a = R.claudeArgs();
  const p = fs.readFileSync(path.join(__dirname, '..', 'prompt.md'), 'utf8');
  const hosts = [...new Set([...p.matchAll(/https:\/\/([A-Za-z0-9.-]+)\//g)].map(m => m[1]))].sort();
  assert.ok(hosts.includes('api.github.com'), hosts.join());
  const allow = argsAfter(a, '--allowedTools');
  assert.ok(!allow.includes('WebFetch'), 'bare WebFetch allows every host');
  assert.deepStrictEqual(allow.filter(t => t.startsWith('WebFetch')).sort(), hosts.map(h => `WebFetch(domain:${h})`));
  assert.ok(argsAfter(a, '--tools').includes('WebFetch'));
});

test('claude args isolate the session from user settings and plugin hooks', () => {
  const a = R.claudeArgs();
  assert.deepStrictEqual(argsAfter(a, '--setting-sources'), ['']);
  assert.deepStrictEqual(JSON.parse(argsAfter(a, '--settings')[0]), { disableAllHooks: true });
});

// ---------- notice / seen ----------

test('notice: new report -> message; after seen -> silent; newer failure -> failure message; nothing at all -> silent', () => {
  const state = tmp('bajzi-radar-n-');
  assert.strictEqual(R.notice(state), '');
  const rep = path.join(state, 'reports', '2026-10-01.md');
  write(rep, '# bajzi radar - 2026-10-01\n');
  setM(rep, new Date(Date.now() - 60e3));
  const m = JSON.parse(R.notice(state));
  assert.strictEqual(m.systemMessage, 'bajzi radar: new report ' + rep + ' - run /bajzi:radar to review');
  R.seen(state);
  assert.ok(fs.existsSync(path.join(state, '.seen')));
  assert.strictEqual(R.notice(state), '');
  const err = path.join(state, 'last-error.log');
  write(err, 'exit code: 1\n');
  setM(err, new Date(Date.now() + 60e3));
  assert.strictEqual(JSON.parse(R.notice(state)).systemMessage, 'bajzi radar: last run failed - ' + err);
  setM(err, new Date(Date.now() - 120e3));
  assert.strictEqual(R.notice(state), '');
});

test('notice: a failure with no report and no .seen is reported', () => {
  const state = tmp('bajzi-radar-n-');
  write(path.join(state, 'last-error.log'), 'x');
  assert.match(JSON.parse(R.notice(state)).systemMessage, /^bajzi radar: last run failed - /);
});

test('notice: a failure with no report goes silent once seen is newer than last-error.log', () => {
  const state = tmp('bajzi-radar-n-');
  const err = path.join(state, 'last-error.log');
  write(err, 'x');
  setM(err, new Date(Date.now() - 60e3));
  assert.match(JSON.parse(R.notice(state)).systemMessage, /^bajzi radar: last run failed - /);
  R.seen(state);
  assert.strictEqual(R.notice(state), '');
});

test('notice CLI: a missing state dir is silent with exit 0', () => {
  const r = spawnSync(process.execPath, [RADAR, 'notice'], {
    encoding: 'utf8', env: { ...process.env, BAJZI_RADAR_HOME: path.join(tmp('bajzi-radar-x-'), 'nope', 'deeper') },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

test('stateDir: BAJZI_RADAR_HOME wins, else ~/.claude/bajzi/radar', () => {
  assert.strictEqual(R.stateDir({ BAJZI_RADAR_HOME: '/x/y' }), '/x/y');
  assert.strictEqual(R.stateDir({}), path.join(os.homedir(), '.claude', 'bajzi', 'radar'));
});

// ---------- install-task ----------

test('install command builder: biweekly Monday 10:00, the four settings, current user only (no SYSTEM, no Highest)', () => {
  const c = R.taskCommand({ node: 'C:\\Program Files\\nodejs\\node.exe', launch: "C:\\Users\\o'b\\.claude\\bajzi\\radar\\launch.js" });
  for (const s of ['-WeeksInterval 2', '-DaysOfWeek Monday', "-At '10:00'", '-StartWhenAvailable', '-RunOnlyIfNetworkAvailable',
    '-ExecutionTimeLimit (New-TimeSpan -Hours 1)', '-MultipleInstances IgnoreNew', 'Register-ScheduledTask -TaskName bajzi-radar', '-Force',
    "'C:\\Program Files\\nodejs\\node.exe'", "o''b", 'NextRunTime']) {
    assert.ok(c.includes(s), s + '\n' + c);
  }
  assert.doesNotMatch(c, /system/i);
  assert.doesNotMatch(c, /highest/i);
  assert.doesNotMatch(c, /runas|elevat/i);
});

test('install-task on Windows writes launch.js and runs the builder output through powershell -EncodedCommand', () => {
  const state = tmp('bajzi-radar-i-');
  let call;
  const exec = (bin, args) => { call = { bin, args }; return { status: 0, stdout: 'NextRunTime: 2026-10-12 10:00\n', stderr: '' }; };
  const r = R.installTask({ platform: 'win32', state, node: 'C:\\node.exe', exec });
  const launch = path.join(state, 'launch.js');
  assert.ok(fs.existsSync(launch));
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /NextRunTime: 2026-10-12 10:00/);
  assert.match(call.bin, /^powershell(\.exe)?$/i);
  const enc = call.args[call.args.indexOf('-EncodedCommand') + 1];
  assert.strictEqual(Buffer.from(enc, 'base64').toString('utf16le'), R.taskCommand({ node: 'C:\\node.exe', launch }));
});

test('install-task on Windows reports failure (code 1) when powershell exits non-zero or cannot start', () => {
  const state = tmp('bajzi-radar-i-');
  const bad = R.installTask({ platform: 'win32', state, node: 'C:\\node.exe', exec: () => ({ status: 1, stdout: '', stderr: 'Access is denied.' }) });
  assert.strictEqual(bad.code, 1);
  assert.match(bad.out, /Access is denied/);
  const gone = R.installTask({ platform: 'win32', state, node: 'C:\\node.exe', exec: () => { throw new Error('spawn powershell.exe ENOENT'); } });
  assert.strictEqual(gone.code, 1);
});

test('install-task elsewhere prints a biweekly crontab line for launch.js and registers nothing', () => {
  const state = tmp('bajzi-radar-i-');
  const r = R.installTask({ platform: 'linux', state, node: '/usr/bin/node', exec: () => { throw new Error('must not exec'); } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /^0 10 \* \* 1 /m);
  assert.ok(r.out.includes('"/usr/bin/node" "' + path.join(state, 'launch.js') + '"'));
  assert.ok(r.out.includes('\\%'));
  assert.ok(fs.existsSync(path.join(state, 'launch.js')));
});

test('launch.js resolves the CURRENT bajzi installPath at launch and runs its radar.js run with the state dir', () => {
  const state = tmp('bajzi-radar-l-');
  const home = tmp('bajzi-radar-h-');
  R.installTask({ platform: 'linux', state, node: process.execPath, exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  const marker = path.join(home, 'marker.json');
  const plant = ver => {
    const root = path.join(home, 'cache', ver);
    write(path.join(root, 'skills', 'radar', 'radar.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ ver: ${JSON.stringify(ver)}, argv: process.argv.slice(2), state: process.env.BAJZI_RADAR_HOME }));`);
    write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'bajzi@bajzi-plugins': [{ installPath: root }] } }));
  };
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.BAJZI_RADAR_HOME;
  plant('1.11.0');
  assert.strictEqual(spawnSync(process.execPath, [path.join(state, 'launch.js')], { env }).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { ver: '1.11.0', argv: ['run'], state });
  plant('1.12.0');
  spawnSync(process.execPath, [path.join(state, 'launch.js')], { env });
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).ver, '1.12.0');
});

test('the cron command finds claude under an env with PATH=/usr/bin:/bin', () => {
  const state = tmp('bajzi-radar-c-');
  const home = tmp('bajzi-radar-h-');
  const bin = tmp('bajzi-radar-bin-');
  write(path.join(bin, 'claude'), '#!/bin/sh\n');
  // install-task runs from the owner's shell, where claude is on PATH
  R.installTask({ platform: 'linux', state, node: process.execPath, env: { PATH: bin + path.delimiter + '/usr/bin' }, exec: () => { throw new Error('must not exec'); } });
  const marker = path.join(home, 'found.json');
  const root = path.join(home, 'cache', '1.11.0');
  write(path.join(root, 'skills', 'radar', 'radar.js'), `const fs = require('fs'), path = require('path');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify((process.env.PATH || '').split(path.delimiter).find(d => d && fs.existsSync(path.join(d, 'claude'))) || null));`);
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'bajzi@bajzi-plugins': [{ installPath: root }] } }));
  // cron's environment: PATH=/usr/bin:/bin, nothing from the owner's shell
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k) && k !== 'BAJZI_RADAR_HOME'));
  Object.assign(env, { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home });
  assert.strictEqual(spawnSync(process.execPath, [path.join(state, 'launch.js')], { env }).status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), bin);
});

test('launch.js with no resolvable install exits 1, writes last-error.log, and notice reports it', () => {
  const state = tmp('bajzi-radar-l-');
  const home = tmp('bajzi-radar-h-');
  R.installTask({ platform: 'linux', state, node: process.execPath, exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  assert.strictEqual(spawnSync(process.execPath, [path.join(state, 'launch.js')], { env }).status, 1);
  assert.match(fs.readFileSync(path.join(state, 'last-error.log'), 'utf8'), /cannot resolve the bajzi install/);
  assert.match(JSON.parse(R.notice(state)).systemMessage, /^bajzi radar: last run failed - /);
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'bajzi@bajzi-plugins': [{ installPath: path.join(home, 'nope') }] } }));
  fs.rmSync(path.join(state, 'last-error.log'));
  assert.strictEqual(spawnSync(process.execPath, [path.join(state, 'launch.js')], { env }).status, 1);
  assert.match(fs.readFileSync(path.join(state, 'last-error.log'), 'utf8'), /missing /);
});

// ---------- prompt.md / SKILL.md pins ----------

test('prompt.md carries the pinned sources, the untrusted-web rule and the output contract', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'prompt.md'), 'utf8');
  for (const s of ['https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md', 'https://platform.claude.com/docs/en/release-notes/overview',
    'https://www.anthropic.com/news', 'https://www.anthropic.com/engineering', 'https://api.github.com/repos/obra/superpowers/releases',
    '# bajzi radar - <YYYY-MM-DD>', 'deliberately_skipped', 'declined.md', 'Considered and dropped', 'Nothing worth changing', 'untrusted']) {
    assert.ok(p.includes(s), s);
  }
});

test('SKILL.md: name radar, the three entry points, the seen step', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  assert.match(s, /^---\nname: radar\ndescription: .+\n---\n/);
  for (const x of ['/bajzi:radar now', '/bajzi:radar install', 'radar.js" seen', 'radar.js" run', 'radar.js" install-task', 'declined.md']) assert.ok(s.includes(x), x);
});
