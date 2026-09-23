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
