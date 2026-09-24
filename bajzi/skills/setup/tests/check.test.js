'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rtkConfigPath } = require('../check');

const CHECK = path.join(__dirname, '..', 'check.js');
const REAL_MANIFEST = path.join(__dirname, '..', 'manifest.json');
const SKILL = path.join(__dirname, '..', 'SKILL.md');

const MANIFEST = {
  marketplaces: [{ source: 'anthropics/claude-plugins-official' }, { source: 'bajzaa975/claude-alapcsomag' }],
  plugins: [{ id: 'bajzi@bajzi-plugins' }, { id: 'superpowers@claude-plugins-official' }],
  settings_merge: { theme: 'dark', permissions: { defaultMode: 'auto', deny: ['Read(.env)'] }, env: { PONYTAIL_DEFAULT_MODE: 'lite' } },
  user_mcps: { 'token-savior': {}, 'code-review-graph': {} },
  rtk: { required: false, exclude_commands: ['ssh', 'curl'] },
  bajzi_config: { path: '~/.claude/bajzi/config.json', reviewer_models: ['claude-a-1', 'claude-b-2'] },
  forbidden_leftovers: {
    paths: ['~/.claude/hooks/gsd-*', '~/.claude/gsd-core', '~/.claude-mem'],
    settings_substrings: ['gsd-', '.planning/'],
  },
};

function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-chk-'));
  const c = path.join(home, '.claude');
  fs.mkdirSync(path.join(c, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(c, 'bajzi'), { recursive: true });
  const w = (rel, v) => fs.writeFileSync(path.join(home, rel), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  w('.claude/plugins/known_marketplaces.json', {
    'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
    'bajzi-plugins': { source: { source: 'github', repo: 'bajzaa975/claude-alapcsomag' } },
  });
  w('.claude/plugins/installed_plugins.json', { version: 2, plugins: {
    'bajzi@bajzi-plugins': [{ scope: 'user' }],
    'superpowers@claude-plugins-official': [{ scope: 'user' }],
    'frontend-design@claude-plugins-official': [{ scope: 'project', projectPath: 'x' }],
  } });
  const statusFile = path.join(c, 'bajzi', 'statusline.js');
  fs.writeFileSync(statusFile, '// stub\n');
  w('.claude/settings.json', { theme: 'dark', permissions: { defaultMode: 'auto', deny: ['Read(.env)', 'Read(x)'] }, env: { PONYTAIL_DEFAULT_MODE: 'lite' },
    statusLine: { type: 'command', command: `node "${statusFile.split(path.sep).join('/')}"` } });
  w('.claude.json', { mcpServers: { 'token-savior': {}, 'code-review-graph': {} } });
  w('.claude/bajzi-mode', 'day-run\n');
  w('.claude/bajzi/config.json', { reviewer_models: ['claude-a-1', 'claude-b-2'] });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'rtk'), '');
  fs.writeFileSync(path.join(bin, 'rtk.exe'), '');
  const env = { BAJZI_HOME: home, PATH: bin, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config') };
  const cfg = rtkConfigPath(home, env);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '[hooks]\nexclude_commands = [\n  "ssh",\n  "curl",\n]\n');
  const mpath = path.join(home, 'manifest.json');
  fs.writeFileSync(mpath, JSON.stringify(MANIFEST));
  env.BAJZI_MANIFEST = mpath;
  return { home, c, env, statusFile };
}

function run(m, args = []) {
  const env = Object.assign({ SystemRoot: process.env.SystemRoot || '' }, m.env);
  const r = spawnSync(process.execPath, [CHECK, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const edit = (m, rel, fn) => {
  const p = path.join(m.home, rel);
  const v = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(v);
  fs.writeFileSync(p, JSON.stringify(v));
};

test('a machine matching the manifest is clean (exit 0)', () => {
  const r = run(machine());
  assert.strictEqual(r.out, 'setup --check: clean\n');
  assert.strictEqual(r.code, 0);
});

test('plugins: missing and extra user-scope plugins drift; project-scope ones are ignored', () => {
  const m = machine();
  edit(m, '.claude/plugins/installed_plugins.json', v => {
    delete v.plugins['superpowers@claude-plugins-official'];
    v.plugins['claude-mem@thedotmack'] = [{ scope: 'user' }];
  });
  const r = run(m);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DRIFT plugin-missing superpowers@claude-plugins-official$/m);
  assert.match(r.out, /^DRIFT plugin-extra claude-mem@thedotmack$/m);
  assert.doesNotMatch(r.out, /frontend-design/);
  assert.match(r.out, /setup --check: 2 drift item\(s\)\n$/);
});

test('marketplaces: missing and extra', () => {
  const m = machine();
  edit(m, '.claude/plugins/known_marketplaces.json', v => {
    delete v['bajzi-plugins'];
    v.ponytail = { source: { source: 'github', repo: 'DietrichGebert/ponytail' } };
  });
  const r = run(m);
  assert.match(r.out, /^DRIFT marketplace-missing bajzaa975\/claude-alapcsomag$/m);
  assert.match(r.out, /^DRIFT marketplace-extra ponytail$/m);
});

test('settings_merge: wrong scalar and missing array item drift', () => {
  const m = machine();
  edit(m, '.claude/settings.json', v => { v.theme = 'light'; v.permissions.deny = ['Read(x)']; });
  const r = run(m);
  assert.match(r.out, /^DRIFT setting-drift theme is "light", want "dark"$/m);
  assert.match(r.out, /^DRIFT setting-drift permissions\.deny missing "Read\(\.env\)"$/m);
});

test('permissions.defaultMode: missing and different values drift (owner 2026-09-23)', () => {
  const m = machine();
  edit(m, '.claude/settings.json', v => { delete v.permissions.defaultMode; });
  let r = run(m);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DRIFT setting-drift permissions\.defaultMode is undefined, want "auto"$/m);
  edit(m, '.claude/settings.json', v => { v.permissions.defaultMode = 'acceptEdits'; });
  r = run(m);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DRIFT setting-drift permissions\.defaultMode is "acceptEdits", want "auto"$/m);
});

test('status line: foreign command, missing command, missing file', () => {
  const m = machine();
  edit(m, '.claude/settings.json', v => { v.statusLine.command = 'node "C:/x/.claude/hooks/gsd-statusline.js"'; });
  assert.match(run(m).out, /^DRIFT statusline-foreign node "C:\/x\/\.claude\/hooks\/gsd-statusline\.js"$/m);
  edit(m, '.claude/settings.json', v => { delete v.statusLine; });
  assert.match(run(m).out, /^DRIFT statusline-missing /m);
  fs.rmSync(m.statusFile);
  assert.match(run(m).out, /^DRIFT statusline-file-missing ~\/\.claude\/bajzi\/statusline\.js$/m);
});

test('user MCPs, rtk, rtk exclude list and bajzi-mode', () => {
  const m = machine();
  edit(m, '.claude.json', v => { delete v.mcpServers['code-review-graph']; });
  fs.rmSync(path.join(m.home, 'bin', 'rtk'));
  fs.rmSync(path.join(m.home, 'bin', 'rtk.exe'));
  fs.writeFileSync(rtkConfigPath(m.home, m.env), '[hooks]\nexclude_commands = ["ssh"]\n');
  fs.rmSync(path.join(m.c, 'bajzi-mode'));
  const r = run(m);
  assert.match(r.out, /^DRIFT mcp-missing code-review-graph$/m);
  assert.match(r.out, /^DRIFT rtk-missing /m);
  assert.match(r.out, /^DRIFT rtk-exclude-missing curl$/m);
  assert.match(r.out, /^DRIFT bajzi-mode-missing /m);
  fs.rmSync(rtkConfigPath(m.home, m.env));
  assert.match(run(m).out, /^DRIFT rtk-config-missing /m);
});

test('forbidden leftovers: files, dirs and settings substrings', () => {
  const m = machine();
  fs.mkdirSync(path.join(m.c, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(m.c, 'hooks', 'gsd-statusline.js'), '');
  fs.writeFileSync(path.join(m.c, 'hooks', 'my-own-hook.js'), '');
  fs.mkdirSync(path.join(m.c, 'gsd-core'));
  fs.mkdirSync(path.join(m.home, '.claude-mem'));
  edit(m, '.claude/settings.json', v => {
    v.hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/gsd-secret-read-guard.js' }] }] };
    v.permissions.allow = ['Read(.planning/*)'];
  });
  const r = run(m);
  assert.match(r.out, /^DRIFT leftover \.claude\/hooks\/gsd-statusline\.js$/m);
  assert.match(r.out, /^DRIFT leftover \.claude\/gsd-core$/m);
  assert.match(r.out, /^DRIFT leftover \.claude-mem$/m);
  assert.match(r.out, /^DRIFT leftover-setting gsd-$/m);
  assert.match(r.out, /^DRIFT leftover-setting \.planning\/$/m);
  assert.doesNotMatch(r.out, /my-own-hook/);
});

test('unreadable settings.json is reported, not a crash', () => {
  const m = machine();
  fs.writeFileSync(path.join(m.c, 'settings.json'), '{ broken');
  const r = run(m);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DRIFT unreadable settings\.json$/m);
  assert.strictEqual(r.err, '');
});

test('--json output and an unreadable manifest (exit 2)', () => {
  const m = machine();
  fs.rmSync(path.join(m.c, 'bajzi-mode'));
  const j = JSON.parse(run(m, ['--json']).out);
  assert.deepStrictEqual(j.drift, [{ id: 'bajzi-mode-missing', detail: '~/.claude/bajzi-mode' }]);
  m.env.BAJZI_MANIFEST = path.join(m.home, 'nope.json');
  assert.strictEqual(run(m).code, 2);
});

test('check.js is read-only: no file under HOME changes', () => {
  const m = machine();
  fs.rmSync(path.join(m.c, 'bajzi-mode'));
  const snap = () => {
    const out = {};
    const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const s = fs.statSync(p);
      if (s.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8') + '|' + s.mtimeMs; } };
    walk(m.home);
    return out;
  };
  const before = snap();
  run(m);
  run(m, ['--json']);
  assert.deepStrictEqual(snap(), before);
});

test('reviewer allow-list: invalid (missing, GLM id) and drifted from the manifest', () => {
  const m = machine();
  const cfg = path.join(m.c, 'bajzi', 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ reviewer_models: ['claude-b-2', 'claude-a-1'] }));
  assert.match(run(m).out, /^DRIFT reviewer-models-drift have claude-b-2,claude-a-1, manifest claude-a-1,claude-b-2$/m);
  fs.writeFileSync(cfg, JSON.stringify({ reviewer_models: ['claude-a-1', 'glm-5.3'] }));
  assert.match(run(m).out, /^DRIFT reviewer-models-invalid .*glm-5\.3/m);
  fs.rmSync(cfg);
  assert.match(run(m).out, /^DRIFT reviewer-models-invalid .*missing/m);
});

test('setup step 11 writes the manifest default under BAJZI_HOME (same override as every reader)', () => {
  const m = machine();
  fs.rmSync(path.join(m.c, 'bajzi', 'config.json'));
  const mm = /node -e "([^"]+)" "\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/setup\/manifest\.json"/.exec(fs.readFileSync(SKILL, 'utf8'));
  assert.ok(mm, 'step 11 command not found in SKILL.md');
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-decoy-'));   // os.homedir() for the child: never the real home
  const r = spawnSync(process.execPath, ['-e', mm[1], m.env.BAJZI_MANIFEST],
    { env: Object.assign({}, process.env, { BAJZI_HOME: m.home, HOME: decoy, USERPROFILE: decoy }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(decoy, '.claude', 'bajzi', 'config.json')), 'wrote under os.homedir(), not BAJZI_HOME');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(m.c, 'bajzi', 'config.json'), 'utf8')), { reviewer_models: ['claude-a-1', 'claude-b-2'] });
  assert.doesNotMatch(run(m).out, /reviewer-models/);
});

test('real manifest: reviewer allow-list default is a valid, non-empty claude- list at ~/.claude/bajzi/config.json', () => {
  const m = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8'));
  assert.strictEqual(m.bajzi_config.path, '~/.claude/bajzi/config.json');
  assert.ok(m.bajzi_config.reviewer_models.length > 0);
  for (const id of m.bajzi_config.reviewer_models) assert.match(id, /^claude-[A-Za-z0-9._-]+$/);
});

test('real manifest: new blocks present, GSD retired, no GSD permissions left', () => {
  const m = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8'));
  assert.strictEqual(m.gsd.default_install, false);
  assert.strictEqual(m.gsd.machine_exception, undefined);
  assert.strictEqual(m.gsd.laptop_retained_hooks, undefined);   // removed at the cut-over (Task 8 Step 10)
  assert.strictEqual(m.settings_merge.permissions.defaultMode, 'auto');
  assert.deepStrictEqual(m.user_mcps['code-review-graph'].args, ['code-review-graph', 'serve']);
  assert.deepStrictEqual(m.secret_patterns, ['*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'credentials.json']);
  assert.match(m.gsd.status, /^retired 2026-09-23/);
  assert.deepStrictEqual(Object.keys(m.user_mcps).sort(), ['code-review-graph', 'token-savior']);
  assert.strictEqual(m.statusline.target, '~/.claude/bajzi/statusline.js');
  assert.ok(m.forbidden_leftovers.paths.includes('~/.claude/gsd-core'));
  assert.deepStrictEqual(m.rtk.exclude_commands, ['ssh', 'scp', 'curl', 'keyring', 'deploy', 'release', 'publish', 'migrate']);
  assert.ok(Array.isArray(m.secret_patterns));
  const sm = JSON.stringify(m.settings_merge);
  assert.ok(!sm.includes('gsd-core') && !sm.includes('.planning') && !sm.includes('STATE.md'), sm);
});

test('setup SKILL.md documents --check, the status line step and user MCPs', () => {
  const s = fs.readFileSync(SKILL, 'utf8');
  assert.match(s, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/setup\/check\.js"/);
  assert.match(s, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/setup\/install-statusline\.js"/);
  assert.match(s, /claude mcp add-json --scope user/);
  assert.match(s, /bajzi_config\.reviewer_models/);
  assert.doesNotMatch(s, /LEAVE the GSD hooks/);
  assert.doesNotMatch(s, /Do not touch the GSD hooks/);
});
