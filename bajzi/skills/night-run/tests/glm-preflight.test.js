'use strict';
// SKILL.md PHASE A step 7 (user-level env deny check) and step 8 (saver-level / GLM preflight), plus the
// two templates step 8 renders. Phrase assertions on whitespace-collapsed text, never a snapshot; the
// step-7 script and the set-zai-key template are also EXECUTED, against decoy HOME dirs only.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SKILL_DIR = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const has = (hay, phrase) => assert.ok(hay.includes(phrase), `missing: ${phrase}`);
const SKILL = read(path.join(SKILL_DIR, 'SKILL.md'));
const ZAI_TMPL = read(path.join(SKILL_DIR, 'templates', 'set-zai-key.sh.tmpl'));
const SMOKE_TMPL = read(path.join(SKILL_DIR, 'templates', 'GLM-SMOKE-PROMPT.md.tmpl'));
const MANIFEST = JSON.parse(read(path.join(SKILL_DIR, '..', 'setup', 'manifest.json')));
const SETTINGS_TMPL = JSON.parse(read(path.join(SKILL_DIR, 'templates', 'settings.local.json.tmpl')));

const phaseA = () => {
  const a = SKILL.indexOf('## PHASE A');
  const b = SKILL.indexOf('### `status` mode');
  assert.ok(a >= 0 && b > a, 'PHASE A precedes status mode');
  return SKILL.slice(a, b);
};
const step = (n) => {
  const A = phaseA();
  const a = A.search(new RegExp(`^${n}\\. \\*\\*`, 'm'));
  assert.ok(a >= 0, `PHASE A step ${n} present`);
  const rest = A.slice(a + 1);
  const b = rest.search(new RegExp(`^${n + 1}\\. \\*\\*`, 'm'));
  return A.slice(a, b >= 0 ? a + 1 + b : A.length);
};

// The explicit env-name list: the manifest's user-level Read denies, and the night template's `**/` ones.
const ENV_NAMES = MANIFEST.settings_merge.permissions.deny
  .map((r) => /^Read\((\.env[^)]*)\)$/.exec(r)).filter(Boolean).map((m) => m[1]);
const listFor = (kind, pre) => ENV_NAMES.map((n) => `${kind}(${pre}${n})`).join(', ');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-glm-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tmp = (tag) => fs.mkdtempSync(path.join(ROOT, `${tag}-`));
const posix = (p) => p.replace(/\\/g, '/');

test('the explicit env list is the same in the manifest and the night settings template', () => {
  assert.ok(ENV_NAMES.length >= 7, `manifest env names: ${ENV_NAMES}`);
  const tmpl = SETTINGS_TMPL.permissions.deny
    .map((r) => /^Read\(\*\*\/(\.env[^)]*)\)$/.exec(r)).filter(Boolean).map((m) => m[1]);
  assert.deepStrictEqual(tmpl, ENV_NAMES);
  assert.ok(ENV_NAMES.every((n) => !n.includes('[')), 'no bracket class in the list');
  assert.ok(!ENV_NAMES.includes('.env.*'), 'never .env.*');
});

// ---------- step 7: user settings deny check ----------

const userDenyScript = () => {
  const m = /```js\n([\s\S]*?)```/.exec(step(7));
  assert.ok(m, 'step 7 carries a ```js block');
  return m[1];
};
const runUserDeny = (files) => {
  const home = tmp('home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(home, '.claude', name), body);
  const script = path.join(tmp('js'), 'user-deny-check.js');
  fs.writeFileSync(script, userDenyScript());
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
  });
  assert.strictEqual(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
};
const deny = (rules) => JSON.stringify({ permissions: { deny: rules } });

test('step 7 text: both messages, explicit-list replacement, no bracket recommendation, owner edits', () => {
  const s = flat(step(7));
  has(s, '~/.claude/settings.json');
  has(s, '~/.claude/settings.local.json');
  has(s, 'USER DENY BLOCKS .env.example: <rule> -> replace it with <explicit list>');
  has(s, 'USER DENY INVERTED: <rule> -> replace it with <explicit list>');
  has(s, 'Never recommend a bracket class');
  has(s, 'Never edit the user\'s settings yourself');
  has(s, 'BLOCKER');
  has(s, 'Write tool');
  has(s, '_comment_env');
});

test('step 7 script: a .env.* deny is BLOCKS with the explicit list, same kind and prefix', () => {
  const out = runUserDeny({
    'settings.json': deny(['Read(**/.env.*)', 'Bash(rm -rf *)', 'Read(**/.env.local)', 'Read(.env.*.local)']),
    'settings.local.json': deny(['Edit(.env.*)']),
  });
  assert.deepStrictEqual(out, [
    `USER DENY BLOCKS .env.example: Read(**/.env.*) -> replace it with ${listFor('Read', '**/')}`,
    `USER DENY BLOCKS .env.example: Edit(.env.*) -> replace it with ${listFor('Edit', '')}`,
  ]);
  assert.ok(out.every((l) => !l.split(' -> ')[1].includes('[')), 'no bracket class recommended');
});

test('step 7 script: a bracket class on an env name is INVERTED', () => {
  const out = runUserDeny({ 'settings.json': deny(['Read(.env.[!e]*)', 'Edit(**/.env.[^e]*)']) });
  assert.deepStrictEqual(out, [
    `USER DENY INVERTED: Read(.env.[!e]*) -> replace it with ${listFor('Read', '')}`,
    `USER DENY INVERTED: Edit(**/.env.[^e]*) -> replace it with ${listFor('Edit', '**/')}`,
  ]);
  assert.ok(out.every((l) => !l.split(' -> ')[1].includes('[')), 'no bracket class recommended');
});

test('step 7 script: a parse error is reported, not fatal; the other file is still checked', () => {
  const out = runUserDeny({ 'settings.json': '{ nope', 'settings.local.json': deny(['Read(.env.*)']) });
  assert.strictEqual(out.length, 2, out.join('\n'));
  assert.match(out[0], /^USER SETTINGS NOT PARSED: .*settings\.json: /);
  assert.strictEqual(out[1], `USER DENY BLOCKS .env.example: Read(.env.*) -> replace it with ${listFor('Read', '')}`);
});

test('step 7 script: clean, missing and odd-shaped settings print nothing', () => {
  assert.deepStrictEqual(runUserDeny({}), []);
  assert.deepStrictEqual(runUserDeny({ 'settings.json': deny(ENV_NAMES.map((n) => `Read(${n})`)) }), []);
  assert.deepStrictEqual(runUserDeny({ 'settings.json': 'null', 'settings.local.json': '{"permissions":{"deny":"x"}}' }), []);
});

// ---------- step 8: saver-level preflight ----------

test('step 8 is gated on L1-L3 through the shared saver resolver; L0 runs nothing', () => {
  const s = flat(step(8));
  has(s, '. "${CLAUDE_PLUGIN_ROOT}/hooks/lib-saver-level.sh"');
  has(s, 'saver_resolve "<BASE>"');
  has(s, 'light|glm|tight)');
  has(s, 'L1-L3');
  has(s, 'At L0 nothing in this step runs');
});

test('step 8 (a): glm and worker on PATH, else the install.sh fix', () => {
  const s = flat(step(8));
  has(s, 'command -v');
  has(s, 'glm worker');
  has(s, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/install.sh"');
});

test('step 8 (b): ZAI_API_KEY check, set-zai-key render and the owner command', () => {
  const s = flat(step(8));
  has(s, 'worker --status');
  has(s, 'ZAI_API_KEY[[:space:]]+found');
  has(s, 'templates/set-zai-key.sh.tmpl');
  has(s, '<NIGHT_DIR>/set-zai-key.sh');
  has(s, 'bash <NIGHT_DIR>/set-zai-key.sh');
  has(s, 'plain bash terminal on the night machine');
});

test('step 8 (c): smoke worktree, glm command with no permission flags, pass rule, cleanup', () => {
  const raw = step(8);
  const s = flat(raw);
  has(s, '<NIGHT_DIR>/wt/SMOKE-GLM');
  has(s, 'night/smoke-glm-');
  has(s, 'origin/<BASE_BRANCH>');
  has(s, 'templates/GLM-SMOKE-PROMPT.md.tmpl');
  has(s, 'SMOKE_DUMMY=1');
  has(s, 'Write tool');
  const glmLines = raw.split('\n').filter((l) => /timeout 1500 glm -p/.test(l));
  assert.strictEqual(glmLines.length, 1, 'exactly one glm smoke command line');
  const g = glmLines[0];
  has(g, 'timeout 1500 glm -p "$(cat ');
  has(g, '--output-format json');
  for (const flag of ['--permission', '--dangerously', '--settings', '--allowed', '--disallowed', '--add-dir']) {
    assert.ok(!g.includes(flag), `glm smoke line carries no ${flag}`);
  }
  assert.ok(!g.includes('.env'), 'the env file is never named in a Bash command (secret guard)');
  has(s, 'owner\'s default mode');
  has(s, 'background');
  has(s, 'STEP 7: DENIED');
  has(s, 'SMOKE_DUMMY');
  has(s, 'GLM SMOKE FAILED');
  has(s, 'exit 75');
  has(s, 'worktree remove --force "<NIGHT_DIR>/wt/SMOKE-GLM"');
  has(s, 'branch -D night/smoke-glm-');
  has(s, 'never push');
  has(s, '~10x slower than Sonnet');
  has(s, '`docker: allowed');
});

test('PHASE A intro names step 8 among the config.env readers', () => {
  has(flat(phaseA()), 'steps 3, 4, 5 and 8');
});

// ---------- GLM-SMOKE-PROMPT template ----------

test('smoke prompt lists every step, the env-read probe and a conditional docker step', () => {
  const t = flat(SMOKE_TMPL);
  for (const p of ['{{WORKTREE}}', '{{INSTALL_CMD}}', '{{TYPECHECK_CMD}}', '{{TEST_CMD}}']) has(t, p);
  assert.match(SMOKE_TMPL, /^\{\{DOCKER_STEP\}\}$/m, 'docker step is its own placeholder line');
  assert.ok(!SMOKE_TMPL.includes('docker ps'), 'no unconditional docker step in the template');
  has(t, 'STEP <n>: OK');
  has(t, 'STEP <n>: FAIL - <exact error>');
  has(t, '1. Install');
  has(t, 'red');
  has(t, 'green');
  has(t, '3. Typecheck');
  has(t, '4. Edit a config file');
  has(t, '5. Append');
  has(t, '.env.example');
  has(t, '6. Commit');
  has(t, 'night/smoke-glm-');
  has(t, 'never push');
  has(t, '7. Read');
  has(t, 'STEP 7: DENIED - <exact message>');
  has(t, 'STEP 7: READ');
  has(t, 'never `git add -A`');
});

// ---------- set-zai-key template ----------

const renderZai = (nightDir) => ZAI_TMPL.split('{{NIGHT_DIR}}').join(nightDir);

test('set-zai-key template: required phrases, no level change, no literal key', () => {
  for (const p of ['set -euo pipefail', '--no-vault-gate', "--purpose 'the Z.ai GLM API key'", '--min-length 20',
    'umask 077', 'chmod 600', 'unset SECRET', '.claude/cc-router.env', '--status',
    '.claude/plugins/cache/*/bajzi-infra/*/skills/secure-passphrase-prompt/scripts/read-secret.sh',
    '$NIGHT_DIR/read-secret.sh', 'sort -V']) has(ZAI_TMPL, p);
  assert.ok(!ZAI_TMPL.includes('--level'), 'never changes the saver level');
  const keyLines = ZAI_TMPL.split('\n').filter((l) => l.includes('ZAI_API_KEY='));
  assert.ok(keyLines.length >= 1 && keyLines.every((l) => l.includes('ZAI_API_KEY=%s')), 'only a printf %s, never a key');
});

test('set-zai-key template: bash -n of the rendered script passes', () => {
  const r = spawnSync('bash', ['-n'], { input: renderZai('/tmp/night-runs/demo'), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

// Runs the rendered script with a DECOY home. Refuses to run unless bash really sees the decoy, so the
// owner's real ~/.claude/cc-router.env can never be touched.
const runZai = (home, nightDir) => {
  const env = Object.assign({}, process.env, { HOME: posix(home), USERPROFILE: home });
  const probe = spawnSync('bash', ['-c', 'printf %s "$HOME"'], { encoding: 'utf8', env });
  assert.ok(probe.stdout.endsWith(path.basename(home)), `bash HOME is the decoy: ${probe.stdout}`);
  const script = path.join(nightDir, 'set-zai-key.sh');
  fs.writeFileSync(script, renderZai(posix(nightDir)));
  return spawnSync('bash', [posix(script)], { encoding: 'utf8', env });
};
const stubSecret = (dir, tag, nightDir, key) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'read-secret.sh'),
    `read_secret_from_user() { printf '%s %s\\n' '${tag}' "$*" >> '${posix(nightDir)}/secret-args.txt'; SECRET='${key}'; }\n`);
};
const stubWorker = (home, nightDir) => {
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const w = path.join(bin, 'worker');
  fs.writeFileSync(w, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${posix(nightDir)}/worker-args.txt'\n` +
    "printf 'level           L2 (glm)\\nmode            glm\\nZAI_API_KEY     found\\nclaude binary   x\\n'\n");
  fs.chmodSync(w, 0o755);
};

test('set-zai-key: no read-secret.sh anywhere exits 1 naming both places, writes nothing', () => {
  const home = tmp('zhome'); const nd = tmp('znd');
  const r = runZai(home, nd);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  has(r.stderr, 'bajzi-infra');
  has(r.stderr, posix(nd) + '/read-secret.sh');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'cc-router.env')), 'no env file written');
});

test('set-zai-key: NIGHT_DIR fallback stores the key, prints only level + key lines, never --level', () => {
  const home = tmp('zhome'); const nd = tmp('znd');
  stubSecret(nd, 'night', nd, 'dummy-key-aaaaaaaaaaaaaaaaaaaa');
  stubWorker(home, nd);
  const r = runZai(home, nd);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const envFile = path.join(home, '.claude', 'cc-router.env');
  assert.strictEqual(read(envFile), 'ZAI_API_KEY=dummy-key-aaaaaaaaaaaaaaaaaaaa\n');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.strictEqual(read(path.join(nd, 'secret-args.txt')).trim(),
    "night --purpose the Z.ai GLM API key --min-length 20 --no-vault-gate");
  assert.strictEqual(read(path.join(nd, 'worker-args.txt')).trim(), '--status');
  assert.deepStrictEqual(r.stdout.trim().split(/\r?\n/), ['level           L2 (glm)', 'ZAI_API_KEY     found']);
  assert.ok(!r.stdout.includes('dummy-key'), 'the key is never printed');
});

test('set-zai-key: the newest plugin-cache read-secret.sh wins over NIGHT_DIR; a re-run replaces the key', () => {
  const home = tmp('zhome'); const nd = tmp('znd');
  const cache = (v) => path.join(home, '.claude', 'plugins', 'cache', 'mk', 'bajzi-infra', v,
    'skills', 'secure-passphrase-prompt', 'scripts');
  stubSecret(cache('1.9.0'), 'v1.9.0', nd, 'old-key-bbbbbbbbbbbbbbbbbbbb');
  stubSecret(cache('1.10.0'), 'v1.10.0', nd, 'new-key-cccccccccccccccccccc');
  stubSecret(nd, 'night', nd, 'night-key-dddddddddddddddddddd');
  stubWorker(home, nd);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'cc-router.env'), 'ZAI_API_KEY=previous\n');
  for (let i = 0; i < 2; i++) assert.strictEqual(runZai(home, nd).status, 0);
  assert.strictEqual(read(path.join(home, '.claude', 'cc-router.env')), 'ZAI_API_KEY=new-key-cccccccccccccccccccc\n');
  const tags = read(path.join(nd, 'secret-args.txt')).trim().split(/\r?\n/).map((l) => l.split(' ')[0]);
  assert.deepStrictEqual(tags, ['v1.10.0', 'v1.10.0']);
});

test('set-zai-key keeps other KEY=VALUE lines and replaces only ZAI_API_KEY', () => {
  const home = tmp('zhome'); const nd = tmp('znd');
  stubSecret(nd, 'night', nd, 'fresh-key-eeeeeeeeeeeeeeeeeeee');
  stubWorker(home, nd);
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cc-router.env'), 'DEEPSEEK_API_KEY=ds-keep\nexport ZAI_API_KEY="old"\nZAI_API_KEY=older\n');
  const r = runZai(home, nd);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(read(path.join(dir, 'cc-router.env')), 'DEEPSEEK_API_KEY=ds-keep\nZAI_API_KEY=fresh-key-eeeeeeeeeeeeeeeeeeee\n');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('cc-router.env')), ['cc-router.env'], 'no temp file left');
});

test('set-zai-key picks the highest version across marketplaces', () => {
  const home = tmp('zhome'); const nd = tmp('znd');
  const cache = (mk, v) => path.join(home, '.claude', 'plugins', 'cache', mk, 'bajzi-infra', v,
    'skills', 'secure-passphrase-prompt', 'scripts');
  stubSecret(cache('mk-z', '1.0.0'), 'mk-z-1.0.0', nd, 'z-key-ffffffffffffffffffffffff');
  stubSecret(cache('mk-a', '2.0.0'), 'mk-a-2.0.0', nd, 'a-key-gggggggggggggggggggggggg');
  stubWorker(home, nd);
  assert.strictEqual(runZai(home, nd).status, 0);
  assert.strictEqual(read(path.join(nd, 'secret-args.txt')).split(' ')[0], 'mk-a-2.0.0');
});

test('step 7 script: .env*, **/.env* and **/.env.** denies are BLOCKS', () => {
  const out = runUserDeny({ 'settings.json': deny(['Read(.env*)', 'Read(**/.env*)', 'Edit(**/.env.**)']) });
  assert.deepStrictEqual(out, [
    `USER DENY BLOCKS .env.example: Read(.env*) -> replace it with ${listFor('Read', '')}`,
    `USER DENY BLOCKS .env.example: Read(**/.env*) -> replace it with ${listFor('Read', '**/')}`,
    `USER DENY BLOCKS .env.example: Edit(**/.env.**) -> replace it with ${listFor('Edit', '**/')}`,
  ]);
});

// ---------- step 8: the bash blocks, EXECUTED (stubs and scratch repos only; never glm, worker or claude) ----------

const PLUGIN_ROOT = path.join(SKILL_DIR, '..', '..');
const ROUTER = path.join(PLUGIN_ROOT, 'bin', 'cc-router.js');
const step8Block = (pred) => {
  const b = [...step(8).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter(pred);
  assert.strictEqual(b.length, 1, `exactly one matching step 8 bash block: ${pred}`);
  return b[0];
};
const cleanEnv = (extra) => {
  const env = Object.assign({}, process.env);
  for (const k of ['ANTHROPIC_BASE_URL', 'CC_WORKER_MODE', 'ZAI_API_KEY', 'CLAUDECODE']) delete env[k];
  return Object.assign(env, extra);
};
const bash = (script, env) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
const stubBin = (names, body) => {
  const d = tmp('bin');
  for (const n of names) { fs.writeFileSync(path.join(d, n), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(d, n), 0o755); }
  return d;
};
// A PATH entry bash can split on `:` (Git Bash: /c/..., never C:/...).
const binPath = (d) => `"$(cd '${posix(d)}' && pwd)"`;
// The REAL `worker --status` (cc-router.js) under a decoy HOME. PATH = node's dir only, so on Windows `reg`
// cannot resolve and a key in the owner's registry never leaks in: the key comes from the decoy env file only.
const realStatus = (key) => {
  const home = tmp('shome');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (key) fs.writeFileSync(path.join(home, '.claude', 'cc-router.env'), `ZAI_API_KEY=${key}\n`);
  const env = cleanEnv({ HOME: home, USERPROFILE: home, CC_ROUTER_ENTRY: 'worker', CC_CLAUDE_BIN: process.execPath,
    CC_WORKER_MODE_FILE: path.join(home, 'wm'), CC_ROUTER_CONFIG: path.join(home, 'c.json'), CC_ROUTER_LOG: path.join(home, 'l.log') });
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env.PATH = path.dirname(process.execPath);
  const r = spawnSync(process.execPath, [ROUTER, '--status'], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, key ? /^ZAI_API_KEY\s+found$/m : /^ZAI_API_KEY\s+MISSING$/m);
  return r.stdout;
};

test('step 8 snippets: the gate prints run/skip per level; the key grep matches real worker --status found/MISSING output', () => {
  const gate = step8Block((b) => b.includes('saver_resolve'));
  for (const [lvl, want] of [['claude', 'SAVER L0 (claude): skip step 8'], ['light', 'SAVER light: run step 8'],
    ['glm', 'SAVER glm: run step 8'], ['tight', 'SAVER tight: run step 8'], ['bogus', 'SAVER L0 (bogus): skip step 8']]) {
    const home = tmp('ghome');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'worker-mode'), `${lvl}\n`);
    const r = bash(gate.split('<BASE>').join(posix(tmp('gbase'))),
      cleanEnv({ HOME: posix(home), USERPROFILE: home, CLAUDE_PLUGIN_ROOT: posix(PLUGIN_ROOT) }));
    assert.strictEqual(r.stdout.trim(), want, `${lvl}: ${r.stderr}`);
  }

  const launch = step8Block((b) => b.includes('command -v'));
  const onlyWorker = stubBin(['worker'], 'exit 0');
  assert.strictEqual(bash(`PATH=${binPath(onlyWorker)}\n${launch}`, cleanEnv({})).stdout.trim(), 'BLOCKER: glm not on PATH');
  const both = stubBin(['glm', 'worker'], 'exit 0');
  assert.strictEqual(bash(`PATH=${binPath(both)}\n${launch}`, cleanEnv({})).stdout, '');

  const key = step8Block((b) => b.includes('worker --status'));
  for (const [k, want] of [['dummy-key-hhhhhhhhhhhhhhhhhhhh', 'ZAI KEY FOUND'], ['', 'ZAI KEY MISSING']]) {
    const out = path.join(tmp('st'), 'status.txt');
    fs.writeFileSync(out, realStatus(k));
    const w = stubBin(['worker'], `cat '${posix(out)}'`);
    assert.strictEqual(bash(`PATH=${binPath(w)}:"$PATH"\n${key}`, cleanEnv({})).stdout.trim(), want);
  }
});

// A scratch origin + base clone. /usr/bin/git is replaced by `git` (Git Bash has no /usr/bin/git).
test('step 8 (c) setup clears a registered-but-deleted or unregistered SMOKE-GLM leftover; cleanup removes the worktree', () => {
  const setup = step8Block((b) => b.includes('worktree add'));
  const cleanup = step8Block((b) => b.includes('worktree remove') && !b.includes('worktree add'));
  const gcfg = path.join(tmp('gcfg'), 'gitconfig');
  fs.writeFileSync(gcfg, '');
  const env = cleanEnv({ GIT_CONFIG_GLOBAL: gcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  const git = (cwd, ...a) => {
    const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const BR = 'night/smoke-glm-2026-10-03';
  for (const state of ['none', 'registered-deleted', 'unregistered']) {
    const root = tmp('wt');
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(root, 'init', '-q', '-b', 'main', 'base');
    const base = path.join(root, 'base'), nd = path.join(root, 'night'), wt = path.join(nd, 'wt', 'SMOKE-GLM');
    git(base, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(base, 'remote', 'add', 'origin', posix(path.join(root, 'origin.git')));
    git(base, 'push', '-q', 'origin', 'main');
    fs.mkdirSync(path.join(nd, 'wt'), { recursive: true });
    if (state === 'registered-deleted') {
      git(base, 'worktree', 'add', '-q', '-b', BR, posix(wt), 'origin/main');
      fs.rmSync(wt, { recursive: true, force: true });
    }
    if (state === 'unregistered') { fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'junk'), 'x'); }
    const render = (s) => s.split('/usr/bin/git').join('git').split('<BASE>').join(posix(base))
      .split('<NIGHT_DIR>').join(posix(nd)).split('<date>').join('2026-10-03').split('<BASE_BRANCH>').join('main');
    const r = bash(render(setup), env);
    assert.ok(fs.existsSync(path.join(wt, '.git')), `${state}: worktree created\n${r.stdout}${r.stderr}`);
    assert.strictEqual(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), BR, state);
    assert.ok(fs.existsSync(path.join(nd, 'logs')), `${state}: logs dir`);
    const c = bash(render(cleanup), env);
    assert.ok(!fs.existsSync(wt), `${state}: cleanup removed the worktree\n${c.stderr}`);
    assert.strictEqual(git(base, 'branch', '--list', BR), '', `${state}: cleanup deleted the branch`);
  }
});
