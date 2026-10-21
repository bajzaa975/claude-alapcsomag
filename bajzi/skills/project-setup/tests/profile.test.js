'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../profile');

const CLI = path.join(__dirname, '..', 'profile.js');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

function repo() {
  const r = tmp('bajzi-prof-');
  fs.mkdirSync(path.join(r, 'tools', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(r, 'tools', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');
  fs.mkdirSync(path.join(r, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(r, 'docs', 'rules.md'), '# rules\n');
  fs.writeFileSync(path.join(r, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  return r;
}
const home = () => { const h = tmp('bajzi-ph-'); fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true }); return h; };
const FULL = {
  version: 1,
  methodology: 'superpowers',
  mcpServers: { 'code-review-graph': { command: 'uvx', args: ['code-review-graph', 'serve'], type: 'stdio' } },
  skills: ['tools/skills/deploy'],
  instructions: ['docs/rules.md'],
};

test('validate: a full v1 profile is ok; an empty object is ok (all keys optional)', () => {
  assert.deepStrictEqual(P.validate(FULL), { ok: true, errors: [] });
  assert.deepStrictEqual(P.validate({}), { ok: true, errors: [] });
});

test('validate: unknown key and newer version are refused with a named reason', () => {
  assert.match(P.validate({ version: 1, hooks: {} }).errors.join('\n'), /unknown key "hooks"/);
  assert.match(P.validate({ version: 2 }).errors.join('\n'), /profile version 2 is newer than this bajzi supports \(1\)/);
  assert.match(P.validate({ version: '1' }).errors.join('\n'), /"version" must be 1/);
});

test('validate: bad values are refused', () => {
  const bad = [
    { methodology: 'waterfall' }, { plugins: [{ id: 'no-at-sign' }] }, { plugins: [{ id: 'a@b', extra: 1 }] },
    { plugins: [{ id: 'a@b', marketplace: 'not a repo' }] }, { mcpServers: { x: { args: [] } } },
    { mcpServers: { x: { command: 'c', args: [1] } } }, { skills: ['/abs/path'] }, { skills: ['../outside'] },
    { instructions: ['C:\\x.md'] }, [], null,
  ];
  for (const b of bad) assert.strictEqual(P.validate(b).ok, false, JSON.stringify(b));
});

test('plan on a fresh repo lists methodology, mcp, skill and instructions actions', () => {
  const r = repo();
  assert.deepStrictEqual(P.plan(FULL, r, { home: home() }).map(a => `${a.kind} ${a.target}`), [
    'methodology .claude/METHODOLOGY', 'mcp .mcp.json:code-review-graph', 'skill .claude/skills/deploy', 'instructions .claude/CLAUDE.md',
  ]);
});

test('apply: writes METHODOLOGY, merges .mcp.json keeping foreign entries, links the skill, adds the import block', () => {
  const r = repo();
  const h = home();
  const res = P.apply(FULL, r, { home: h, run: () => 0 });
  assert.deepStrictEqual(res.failures, []);
  assert.strictEqual(fs.readFileSync(path.join(r, '.claude', 'METHODOLOGY'), 'utf8'), 'superpowers\n');
  const mcp = JSON.parse(fs.readFileSync(path.join(r, '.mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcp.mcpServers).sort(), ['code-review-graph', 'other']);
  assert.strictEqual(fs.realpathSync(path.join(r, '.claude', 'skills', 'deploy')), fs.realpathSync(path.join(r, 'tools', 'skills', 'deploy')));
  assert.ok(fs.existsSync(path.join(r, '.claude', 'skills', 'deploy', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(r, '.claude', 'CLAUDE.md'), 'utf8'), /<!-- bajzi:project-setup instructions begin -->\n@\.\.\/docs\/rules\.md\n<!-- bajzi:project-setup instructions end -->/);
  assert.deepStrictEqual(P.plan(FULL, r, { home: h }), []);   // idempotent
  assert.deepStrictEqual(P.check(FULL, r, { home: h }), []);
});

test('apply keeps existing .claude/CLAUDE.md text and replaces only its own block', () => {
  const r = repo();
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'CLAUDE.md'), '# Mine\nkeep me\n');
  P.apply({ instructions: ['docs/rules.md'] }, r, { home: home(), run: () => 0 });
  P.apply({ instructions: ['docs/rules.md'] }, r, { home: home(), run: () => 0 });
  const t = fs.readFileSync(path.join(r, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(t, /^# Mine\nkeep me\n/);
  assert.strictEqual(t.split('bajzi:project-setup instructions begin').length, 2);   // exactly one block
});

test('apply refuses an invalid profile and writes nothing', () => {
  const r = repo();
  const before = fs.readFileSync(path.join(r, '.mcp.json'), 'utf8');
  assert.throws(() => P.apply(Object.assign({}, FULL, { surprise: 1 }), r, { home: home(), run: () => 0 }), e => e instanceof P.ProfileError && /unknown key "surprise"/.test(e.errors.join()));
  assert.strictEqual(fs.readFileSync(path.join(r, '.mcp.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(r, '.claude')));
});

test('apply refuses when a preflight check fails (missing skill source) and writes nothing', () => {
  const r = repo();
  assert.throws(() => P.apply(Object.assign({}, FULL, { skills: ['tools/skills/missing'] }), r, { home: home(), run: () => 0 }), /does not exist/);
  assert.ok(!fs.existsSync(path.join(r, '.claude')));
  fs.writeFileSync(path.join(r, '.mcp.json'), '{ broken');
  assert.throws(() => P.apply(FULL, r, { home: home(), run: () => 0 }), /\.mcp\.json is not valid JSON/);
  assert.ok(!fs.existsSync(path.join(r, '.claude')));
});

test('plugins: marketplace add then project-scope install via the injected runner; installed = no action', () => {
  const r = repo();
  const h = home();
  const calls = [];
  const prof = { plugins: [{ id: 'tool@acme', marketplace: 'acme/claude-tools' }] };
  const res = P.apply(prof, r, { home: h, run: (args, cwd) => { calls.push([args.join(' '), cwd]); return 0; } });
  assert.deepStrictEqual(calls.map(c => c[0]), ['plugin marketplace add acme/claude-tools', 'plugin install tool@acme --scope project']);
  assert.strictEqual(calls[1][1], r);
  assert.deepStrictEqual(res.failures, []);
  fs.writeFileSync(path.join(h, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ acme: { source: { source: 'github', repo: 'acme/claude-tools' } } }));
  fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tool@acme': [{ scope: 'project', projectPath: r }] } }));
  assert.deepStrictEqual(P.plan(prof, r, { home: h }), []);
});

test('a failing plugin install is reported, files stay applied', () => {
  const r = repo();
  const res = P.apply({ methodology: 'superpowers', plugins: [{ id: 'tool@acme' }] }, r, { home: home(), run: () => 1 });
  assert.deepStrictEqual(res.failures, ['plugin tool@acme: claude exited 1']);
  assert.ok(fs.existsSync(path.join(r, '.claude', 'METHODOLOGY')));
});

test('check reports drift after a manual edit', () => {
  const r = repo();
  const h = home();
  P.apply(FULL, r, { home: h, run: () => 0 });
  fs.writeFileSync(path.join(r, '.claude', 'METHODOLOGY'), 'gsd\n');
  assert.deepStrictEqual(P.check(FULL, r, { home: h }), ['DRIFT methodology .claude/METHODOLOGY']);
});

function cli(r, args) {
  const env = Object.assign({}, process.env, { BAJZI_HOME: home() });
  const x = spawnSync(process.execPath, [CLI, '--repo', r, ...args], { env, encoding: 'utf8' });
  return { code: x.status, out: x.stdout || '' };
}

test('CLI: no profile = nothing to do (exit 0); refused profile = exit 2; --check and --dry-run', () => {
  const r = repo();
  const none = cli(r, ['--check']);
  assert.strictEqual(none.code, 0);
  assert.match(none.out, /no \.claude\/project-profile\.json/);
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'project-profile.json'), JSON.stringify({ version: 9 }));
  const refused = cli(r, []);
  assert.strictEqual(refused.code, 2);
  assert.match(refused.out, /REFUSED: profile version 9/);
  fs.writeFileSync(path.join(r, '.claude', 'project-profile.json'), JSON.stringify({ version: 1, methodology: 'superpowers' }));
  assert.deepStrictEqual(cli(r, ['--dry-run']).out.trim().split('\n'), ['WOULD methodology .claude/METHODOLOGY']);
  assert.strictEqual(cli(r, ['--check']).code, 1);
  assert.strictEqual(cli(r, []).code, 0);
  const clean = cli(r, ['--check']);
  assert.strictEqual(clean.code, 0);
  assert.match(clean.out, /project-setup --check: clean/);
});

const GATE_SRC = path.join(__dirname, '..', '..', '..', 'gate', 'pre-commit.js');
function gitRepo(hooksPath) {
  const r = repo();
  spawnSync('git', ['init', '-q'], { cwd: r });
  if (hooksPath) spawnSync('git', ['config', 'core.hooksPath', hooksPath], { cwd: r });
  return r;
}
const GATE = { gate: { tools: ['gitleaks', 'ruff', 'pyright'], baseline: '.gate-baseline.json' } };

test('validate: gate key (tools from the gate list, relative baseline); bad shapes refused', () => {
  assert.deepStrictEqual(P.validate(Object.assign({ version: 1 }, GATE)), { ok: true, errors: [] });
  assert.deepStrictEqual(P.validate({ gate: { tools: ['tsc'] } }), { ok: true, errors: [] });
  const bad = [{ gate: [] }, { gate: {} }, { gate: { tools: [] } }, { gate: { tools: ['mypy'] } }, { gate: { tools: ['ruff', 'ruff'] } },
    { gate: { tools: ['ruff'], baseline: '/abs.json' } }, { gate: { tools: ['ruff'], extra: 1 } }];
  for (const b of bad) assert.strictEqual(P.validate(b).ok, false, JSON.stringify(b));
});

test('gate: apply installs .githooks/pre-commit as a copy of bajzi/gate/pre-commit.js; idempotent; check clean', () => {
  const r = gitRepo('.githooks');
  assert.deepStrictEqual(P.plan(GATE, r, { home: home() }).map(a => a.kind), ['gate']);
  P.apply(GATE, r, { home: home(), run: () => 0 });
  const dest = path.join(r, '.githooks', 'pre-commit');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), fs.readFileSync(GATE_SRC, 'utf8').replace(/\r\n/g, '\n'));
  if (process.platform !== 'win32') assert.ok(fs.statSync(dest).mode & 0o100);
  assert.deepStrictEqual(P.check(GATE, r, { home: home() }), []);
  fs.appendFileSync(dest, '// local edit\n');
  assert.deepStrictEqual(P.check(GATE, r, { home: home() }), ['DRIFT gate .githooks/pre-commit']);
  P.apply(GATE, r, { home: home(), run: () => 0 });   // an edited bajzi gate is refreshed
  assert.deepStrictEqual(P.check(GATE, r, { home: home() }), []);
});

test('gate: refuses when core.hooksPath is not .githooks, and writes nothing', () => {
  for (const hp of [null, 'hooks']) {
    const r = gitRepo(hp);
    assert.deepStrictEqual(P.check(GATE, r, { home: home() }), ['DRIFT hookspath core.hooksPath', 'DRIFT gate .githooks/pre-commit']);
    assert.throws(() => P.apply(Object.assign({ methodology: 'superpowers' }, GATE), r, { home: home(), run: () => 0 }), /core\.hooksPath is "[^"]*", the gate needs "\.githooks"/);
    assert.ok(!fs.existsSync(path.join(r, '.githooks')));
    assert.ok(!fs.existsSync(path.join(r, '.claude')));
  }
});

test('gate: refuses to overwrite a foreign .githooks/pre-commit', () => {
  const r = gitRepo('.githooks');
  fs.mkdirSync(path.join(r, '.githooks'));
  fs.writeFileSync(path.join(r, '.githooks', 'pre-commit'), '#!/bin/sh\ncode-review-graph update\n');
  assert.throws(() => P.apply(GATE, r, { home: home(), run: () => 0 }), /exists and is not the bajzi gate/);
  assert.match(fs.readFileSync(path.join(r, '.githooks', 'pre-commit'), 'utf8'), /code-review-graph/);
});

test('gate: the tracked hook gets index mode 100755 on apply; a 100644 index entry is DRIFT gate-mode', () => {
  const r = gitRepo('.githooks');
  const mode = () => spawnSync('git', ['ls-files', '-s', '--', '.githooks/pre-commit'], { cwd: r, encoding: 'utf8' }).stdout.split(' ')[0];
  P.apply(GATE, r, { home: home(), run: () => 0 });
  assert.strictEqual(mode(), '');   // untracked: apply stages nothing
  assert.deepStrictEqual(P.check(GATE, r, { home: home() }), []);
  spawnSync('git', ['add', '--chmod=-x', '--', '.githooks/pre-commit'], { cwd: r });   // what a Windows `git add` gives
  assert.strictEqual(mode(), '100644');
  assert.deepStrictEqual(P.check(GATE, r, { home: home() }), ['DRIFT gate-mode .githooks/pre-commit']);
  P.apply(GATE, r, { home: home(), run: () => 0 });
  assert.strictEqual(mode(), '100755');
  assert.deepStrictEqual(P.check(GATE, r, { home: home() }), []);
  fs.appendFileSync(path.join(r, '.githooks', 'pre-commit'), '// local edit\n');   // a refresh of a tracked hook keeps +x
  spawnSync('git', ['add', '--chmod=-x', '--', '.githooks/pre-commit'], { cwd: r });
  P.apply(GATE, r, { home: home(), run: () => 0 });
  assert.strictEqual(mode(), '100755');
});

// ---- size + hosting kit ----
const PREPUSH_SRC = path.join(__dirname, '..', '..', '..', 'gate', 'pre-push.js');
const git = (r, ...a) => spawnSync('git', a, { cwd: r, encoding: 'utf8' });
const read = (r, rel) => fs.readFileSync(path.join(r, rel), 'utf8');
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = ''; walk(p); } else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  })(dir);
  return out;
}

test('validate: size and hosting values; size needs hosting; size M/L needs gate', () => {
  for (const ok of [{ hosting: 'local' }, { hosting: 'github' }, { size: 'XS', hosting: 'local' }, { size: 'S', hosting: 'github' },
    Object.assign({ size: 'M', hosting: 'local' }, GATE), Object.assign({ size: 'L', hosting: 'github' }, GATE)]) {
    assert.deepStrictEqual(P.validate(ok), { ok: true, errors: [] }, JSON.stringify(ok));
  }
  for (const bad of [{ size: 's', hosting: 'local' }, { size: 'XL', hosting: 'local' }, { hosting: 'gitlab' }, { hosting: 'Local' }]) {
    assert.strictEqual(P.validate(bad).ok, false, JSON.stringify(bad));
  }
  assert.match(P.validate({ size: 'S' }).errors.join('\n'), /"size" needs "hosting" \(local or github\)/);
  assert.match(P.validate({ size: 'M', hosting: 'local' }).errors.join('\n'), /size M needs the "gate" key \(the pre-commit gate is part of the M kit\)/);
  assert.match(P.validate({ size: 'L', hosting: 'github' }).errors.join('\n'), /size L needs the "gate" key/);
});

test('kit: a profile without size/hosting plans no kit action, also in a non-git folder', () => {
  const r = repo();
  const kinds = P.plan(FULL, r, { home: home() }).map(a => a.kind);
  assert.deepStrictEqual(kinds, ['methodology', 'mcp', 'skill', 'instructions']);
  P.apply(FULL, r, { home: home(), run: () => 0 });
  assert.deepStrictEqual(P.check(FULL, r, { home: home() }), []);
  assert.ok(!fs.existsSync(path.join(r, '.git')));
  assert.ok(!fs.existsSync(path.join(r, '.gitignore')));
});

test('kit: fresh non-git folder with size S + hosting local -> git init, hooksPath, pre-push, .gitignore, kit block; check clean', () => {
  const r = repo();
  const prof = { size: 'S', hosting: 'local' };
  assert.deepStrictEqual(P.plan(prof, r, { home: home() }).map(a => `${a.kind} ${a.target}`),
    ['git-init .', 'kit .claude/CLAUDE.md', 'gitignore .gitignore', 'prepush .githooks/pre-push']);
  const res = P.apply(prof, r, { home: home(), run: () => 0 });
  assert.deepStrictEqual(res.failures, []);
  assert.ok(fs.existsSync(path.join(r, '.git')));
  assert.strictEqual(git(r, 'config', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
  assert.match(read(r, '.githooks/pre-push'), /bajzi:pre-push/);
  assert.strictEqual(read(r, '.githooks/pre-push'), fs.readFileSync(PREPUSH_SRC, 'utf8').replace(/\r\n/g, '\n'));
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(r, '.githooks', 'pre-push')).mode & 0o100);
  assert.match(read(r, '.gitignore'), /^runtime\/$/m);
  assert.ok(read(r, '.claude/CLAUDE.md').includes(require('../kit').sizeBlock('S', 'local')));
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), []);
});

test('kit: S -> M upgrade only adds; owner files byte-identical, both blocks once', () => {
  const r = repo();
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'CLAUDE.md'), '# Owner\r\nkeep me\r\n');
  fs.writeFileSync(path.join(r, '.gitignore'), 'node_modules\n/runtime\n*.log');
  const S = { size: 'S', hosting: 'local', instructions: ['docs/rules.md'] };
  P.apply(S, r, { home: home(), run: () => 0 });
  fs.appendFileSync(path.join(r, '.claude', 'CLAUDE.md'), 'owner tail\n');
  fs.writeFileSync(path.join(r, 'docs', 'DEPLOY.md'), '# my deploy\n');
  const gi = read(r, '.gitignore');
  assert.strictEqual(gi, 'node_modules\n/runtime\n*.log');   // /runtime counts: no append
  const M = Object.assign({}, S, { size: 'M' }, GATE);
  assert.deepStrictEqual(P.plan(M, r, { home: home() }).map(a => `${a.kind} ${a.target}`),
    ['kit .claude/CLAUDE.md', 'scaffold docs/uat/README.md', 'gate .githooks/pre-commit']);
  P.apply(M, r, { home: home(), run: () => 0 });
  const t = read(r, '.claude/CLAUDE.md');
  assert.ok(t.startsWith('# Owner\r\nkeep me\r\n'));
  assert.ok(t.endsWith('owner tail\n'));
  assert.strictEqual(t.split('bajzi:project-setup instructions begin').length, 2);
  assert.strictEqual(t.split('bajzi:project-setup kit begin').length, 2);
  assert.ok(t.includes(require('../kit').sizeBlock('M', 'local')));
  assert.strictEqual(read(r, 'docs/DEPLOY.md'), '# my deploy\n');
  assert.strictEqual(read(r, '.gitignore'), gi);
  assert.match(read(r, 'docs/uat/README.md'), /TODO/);
  assert.deepStrictEqual(P.check(M, r, { home: home() }), []);
  // downgrade never deletes a scaffold file
  P.apply(S, r, { home: home(), run: () => 0 });
  assert.ok(fs.existsSync(path.join(r, 'docs', 'uat', 'README.md')));
  assert.ok(read(r, '.claude/CLAUDE.md').startsWith('# Owner\r\nkeep me\r\n'));
});

test('kit: a foreign .githooks/pre-push is REFUSED before any write', () => {
  const r = repo();
  fs.mkdirSync(path.join(r, '.githooks'));
  fs.writeFileSync(path.join(r, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  const before = snapshot(r);
  assert.throws(() => P.apply({ size: 'S', hosting: 'local', methodology: 'superpowers' }, r, { home: home(), run: () => 0 }),
    /\.githooks\/pre-push exists and is not the bajzi hosting guard; move it away first/);
  assert.deepStrictEqual(snapshot(r), before);
  assert.ok(!fs.existsSync(path.join(r, '.git')));
});

test('kit: core.hooksPath pointing elsewhere is REFUSED before any write', () => {
  const r = gitRepo('.husky');
  const before = snapshot(r);
  assert.throws(() => P.apply({ size: 'S', hosting: 'local' }, r, { home: home(), run: () => 0 }),
    /core\.hooksPath is "\.husky".*run: git config core\.hooksPath \.githooks/);
  assert.deepStrictEqual(snapshot(r), before);
});

test('kit: hosting github plans no pre-push and no hookspath action', () => {
  const r = gitRepo(null);
  assert.deepStrictEqual(P.plan({ size: 'S', hosting: 'github' }, r, { home: home() }).map(a => a.kind), ['kit', 'gitignore']);
});

test('kit: hosting alone (no size) plans only the git side', () => {
  const r = repo();
  assert.deepStrictEqual(P.plan({ hosting: 'local' }, r, { home: home() }).map(a => a.kind), ['git-init', 'prepush']);
});

test('kit: a folder inside another git repo is REFUSED', () => {
  const outer = gitRepo(null);
  const r = path.join(outer, 'sub');
  fs.mkdirSync(r);
  assert.throws(() => P.apply({ size: 'S', hosting: 'local' }, r, { home: home(), run: () => 0 }), /is inside the git repo .*; run project-setup at the repo root/);
  assert.deepStrictEqual(fs.readdirSync(r), []);
});

test('kit: --check reports pre-push content and index-mode drift; apply repairs both', () => {
  const r = gitRepo('.githooks');
  const prof = { size: 'S', hosting: 'local' };
  const mode = () => git(r, 'ls-files', '-s', '--', '.githooks/pre-push').stdout.split(' ')[0];
  P.apply(prof, r, { home: home(), run: () => 0 });
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), []);
  fs.appendFileSync(path.join(r, '.githooks', 'pre-push'), '// local edit\n');
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), ['DRIFT prepush .githooks/pre-push']);
  P.apply(prof, r, { home: home(), run: () => 0 });
  git(r, 'add', '--chmod=-x', '--', '.githooks/pre-push');
  assert.strictEqual(mode(), '100644');
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), ['DRIFT prepush-mode .githooks/pre-push']);
  P.apply(prof, r, { home: home(), run: () => 0 });
  assert.strictEqual(mode(), '100755');
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), []);
  git(r, 'config', 'core.hooksPath', 'hooks');
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), ['DRIFT hookspath core.hooksPath']);
});

test('kit: a damaged kit block (begin marker, no end) never swallows owner text on later rewrites', () => {
  const r = repo();
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'CLAUDE.md'), '# Owner\n<!-- bajzi:project-setup kit begin -->\nold kit text\nowner text to keep\n');
  P.apply({ size: 'S', hosting: 'github' }, r, { home: home(), run: () => 0 });
  P.apply(Object.assign({ size: 'M', hosting: 'github' }, GATE), r, { home: home(), run: () => 0 });
  const t = read(r, '.claude/CLAUDE.md');
  assert.ok(t.includes('owner text to keep'));
  assert.ok(t.includes(require('../kit').sizeBlock('M', 'github')));
});

test('kit: refuses before any write when git cannot run (not on PATH)', () => {
  const r = repo();
  const before = snapshot(r);
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.throws(() => P.apply({ size: 'S', hosting: 'local' }, r, { home: home(), run: () => 0 }), e => e instanceof P.ProfileError && /git/.test(e.errors.join()));
  } finally { process.env.PATH = saved; }
  assert.deepStrictEqual(snapshot(r), before);
});

test('kit: changing the instructions list keeps the kit block once and unchanged, owner text byte-identical', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, 'docs', 'more.md'), '# more\n');
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'CLAUDE.md'), '# Owner\nkeep me\n');
  P.apply({ size: 'S', hosting: 'github', instructions: ['docs/rules.md'] }, r, { home: home(), run: () => 0 });
  const kitBlock = require('../kit').sizeBlock('S', 'github');
  P.apply({ size: 'S', hosting: 'github', instructions: ['docs/rules.md', 'docs/more.md'] }, r, { home: home(), run: () => 0 });
  const t = read(r, '.claude/CLAUDE.md');
  assert.ok(t.startsWith('# Owner\nkeep me\n'));
  assert.strictEqual(t.split('bajzi:project-setup kit begin').length, 2);
  assert.ok(t.includes(kitBlock));
  assert.ok(t.includes('<!-- bajzi:project-setup instructions begin -->\n@../docs/rules.md\n@../docs/more.md\n<!-- bajzi:project-setup instructions end -->'));
  assert.strictEqual(t.split('bajzi:project-setup instructions begin').length, 2);
});

test('kit: a CRLF checkout of .claude/CLAUDE.md is not kit drift', () => {
  const r = repo();
  const prof = { size: 'S', hosting: 'local' };
  P.apply(prof, r, { home: home(), run: () => 0 });
  const f = path.join(r, '.claude', 'CLAUDE.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n'));
  assert.deepStrictEqual(P.check(prof, r, { home: home() }), []);
});

test('kit: size XS plans the kit block but no runtime ignore line', () => {
  const r = gitRepo(null);
  const kinds = P.plan({ size: 'XS', hosting: 'github' }, r, { home: home() }).map(a => a.kind);
  assert.ok(kinds.includes('kit'));
  assert.ok(!kinds.includes('gitignore'));
});

test('kit: appending to an owner .gitignore keeps its content, CRLF style and adds the missing final newline', () => {
  const r = repo();
  fs.writeFileSync(path.join(r, '.gitignore'), 'node_modules\r\n*.log');
  P.apply({ size: 'S', hosting: 'github' }, r, { home: home(), run: () => 0 });
  assert.strictEqual(read(r, '.gitignore'), 'node_modules\r\n*.log\r\nruntime/\r\n');
});
