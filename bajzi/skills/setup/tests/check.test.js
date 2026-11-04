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
    deny_rules: [{ rule: 'Read(.env.*)', why: 'narrowed to the explicit env list' }],
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
  w('.claude/bajzi/settings-local.json', {});
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

test('advisorModel: real manifest carries it and check reports drift on it', () => {
  assert.strictEqual(JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')).settings_merge.advisorModel, 'opus');
  const m = machine();
  fs.writeFileSync(m.env.BAJZI_MANIFEST, JSON.stringify(Object.assign({}, MANIFEST, { settings_merge: Object.assign({}, MANIFEST.settings_merge, { advisorModel: 'opus' }) })));
  const r = run(m);
  assert.match(r.out, /^DRIFT setting-drift advisorModel is undefined, want "opus"$/m);
  edit(m, '.claude/settings.json', v => { v.advisorModel = 'opus'; });
  assert.strictEqual(run(m).out, 'setup --check: clean\n');
});

test('MCP_TIMEOUT: real manifest pins it, pitfalls and pyright-lsp; check reports env drift on it', () => {
  const real = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8'));
  assert.strictEqual(real.settings_merge.env.MCP_TIMEOUT, '60000');
  const ids = real.known_pitfalls.map(e => e.id);
  assert.ok(ids.includes('uvx-mcp-cold-start-timeout'));
  assert.ok(ids.includes('plugin-update-can-add-a-mod'));
  assert.ok(real.plugins.some(p => p.id === 'pyright-lsp@claude-plugins-official'));
  const m = machine();
  const env = Object.assign({}, MANIFEST.settings_merge.env, { MCP_TIMEOUT: '60000' });
  fs.writeFileSync(m.env.BAJZI_MANIFEST, JSON.stringify(Object.assign({}, MANIFEST, { settings_merge: Object.assign({}, MANIFEST.settings_merge, { env }) })));
  assert.match(run(m).out, /^DRIFT setting-drift env\.MCP_TIMEOUT is undefined, want "60000"$/m);
  edit(m, '.claude/settings.json', v => { v.env.MCP_TIMEOUT = '60000'; });
  assert.strictEqual(run(m).out, 'setup --check: clean\n');
});

test('permissions.defaultMode: missing and different values drift', () => {
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

test('forbidden leftovers: an old broad deny rule left in settings.json permissions.deny', () => {
  const m = machine();
  edit(m, '.claude/settings.json', v => { v.permissions.deny.push('Read(.env.*)', 'Read(.env.*x)'); });
  const r = run(m);
  assert.match(r.out, /^DRIFT leftover-deny Read\(\.env\.\*\): narrowed to the explicit env list$/m);
  assert.doesNotMatch(r.out, /\.env\.\*x/);
  assert.strictEqual(r.code, 1);
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
  assert.strictEqual(m.gsd.laptop_retained_hooks, undefined);
  assert.strictEqual(m.settings_merge.permissions.defaultMode, 'auto');
  // explicit env names keep the tracked .env.example readable; .env.[!e]* was measured inverted on Claude Code 2.1.288
  assert.deepStrictEqual(m.settings_merge.permissions.deny, ['Read(.env)', 'Read(.env.local)', 'Read(.env.*.local)',
    'Read(.env.production*)', 'Read(.env.development*)', 'Read(.env.test*)', 'Read(.env.staging*)', 'Read(.secrets)']);
  assert.deepStrictEqual(m.forbidden_leftovers.deny_rules.map(x => x.rule), ['Read(.env.*)', 'Edit(.env.*)']);
  assert.strictEqual(m.settings_merge.remoteControlAtStartup, true);
  assert.deepStrictEqual(m.user_mcps['code-review-graph'].args, ['code-review-graph', 'serve']);
  assert.deepStrictEqual(m.secret_patterns, ['*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'credentials.json']);
  assert.match(m.gsd.status, /^retired/);
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

test('real manifest lists the mods and the marketplace ships them at their own plugin.json version', () => {
  const m = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8'));
  const root = path.join(__dirname, '..', '..', '..', '..');
  const mp = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  for (const n of ['cache-timer', 'nightrun-pane']) {
    assert.ok(m.plugins.some(p => p.id === `${n}@bajzi-plugins`), n);
    const v = JSON.parse(fs.readFileSync(path.join(root, n, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    const e = mp.plugins.find(p => p.name === n);
    assert.strictEqual(e.source, `./${n}`);
    assert.strictEqual(e.version, v);
  }
});

test('mod docs state the cache-timer 60-minute assumption and the nightrun-pane layout limit', () => {
  const root = path.join(__dirname, '..', '..', '..', '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  // Only the mods' own README bullets and spec §2 row: the same words appear elsewhere in both files.
  const line = (p, re) => read(p).split('\n').filter(l => re.test(l)).join('\n');
  const row = line('docs/bajzi-package-spec.md', /^\| Mods \(cache-timer, nightrun-pane\) \|/);
  assert.ok(row, 'spec §2 Mods row');
  const ct = [read('cache-timer/.claude-plugin/plugin.json'), line('README.md', /^- \*\*`cache-timer`\*\*/), row];
  for (const t of ct) assert.match(t, /60-minute/);
  for (const t of ct) assert.match(t, /overage/);
  const np = [read('nightrun-pane/.claude-plugin/plugin.json'), line('README.md', /^- \*\*`nightrun-pane`\*\*/), row];
  for (const t of np) assert.match(t, /runtime\/nightrun/);
  for (const t of np) assert.match(t, /external orchestrator/);
});

test('setup content stays public-neutral: no plan/task ids, dev box, retained-hook exception, Hungarian triggers', () => {
  const root = path.join(__dirname, '..', '..', '..', '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const manifest = read('bajzi/skills/setup/manifest.json');
  const why = JSON.parse(manifest).plugins.find(p => p.id === 'bajzi@bajzi-plugins').why;
  assert.match(why, /agents/);
  assert.doesNotMatch(why, /plan\)|\bT[345]\b/);
  assert.doesNotMatch(manifest, /dev box/);
  assert.doesNotMatch(read('bajzi/skills/setup/SKILL.md'), /retained-hook/);
  assert.doesNotMatch(read('bajzi/skills/which/SKILL.md'), /melyik|parancs|owner's global/);
});

test('known_pitfalls carry current guidance: no old bajzi versions, no incident narrative', () => {
  const dir = path.join(__dirname, '..', '..', '..');
  const cur = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const pit = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')).known_pitfalls
    .filter(e => !String(e.id || '').startsWith('gsd-'));
  const text = JSON.stringify(pit);
  for (const v of text.match(/(?<![\d.])1\.\d+\.\d+\b/g) || []) assert.strictEqual(v, cur, `old version ${v}`);
  assert.doesNotMatch(text, /found the hard way|caught during|Before 1\./);
});

test('a pinned plugin is never updated or auto-installed by setup PHASE D step 3', () => {
  const plugins = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')).plugins;
  assert.strictEqual(plugins.find(p => p.id === 'ponytail@ponytail').pinned, '4.10.0');
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const step3 = skill.slice(skill.indexOf("3. The manifest's `plugins` list"), skill.indexOf('NEVER RE-ENABLE'));
  assert.ok(step3.length > 100);
  assert.match(step3, /pinned/);
  assert.match(step3, /pinned at <version>, not updated/);
  assert.match(step3, /pinned, install by hand at <version>/);
  assert.match(step3, /claude plugin list/);
  assert.match(step3, /MISMATCH, roll back by hand to <version>/);
  assert.match(step3, /== `pinned`: report "pinned at <version>, not updated"/);
  assert.match(step3, /!= `pinned`: report "pinned at <version>, installed <installed>: MISMATCH/);
  const pit = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8')).known_pitfalls.find(e => e.id === 'plugin-update-can-add-a-mod');
  assert.match(pit.action, /pinned/);
});

test('spec passages quoting the DAY-RUN.log field pattern carry the finish-only rule or point to it', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'bajzi-package-spec.md'), 'utf8');
  let n = 0;
  for (const m of spec.matchAll(/<task-class> model=/g)) {
    n++;
    const w = spec.slice(Math.max(0, m.index - 900), m.index + 900);
    assert.ok((/when it is FINISHED/.test(w) && /never a full id/.test(w)) || /Saver-level routing table row/.test(w), `no finish-only rule near offset ${m.index}`);
  }
  assert.ok(n >= 2);
});

// ---- machine-local settings overlay, public autoMode rule, global rules ----
const OVERLAY = '.claude/bajzi/settings-local.json';
const AUTO = { autoMode: { allow: ['$defaults', '[bajzi] rule v2'] }, permissions: { allow: ['Bash(glm -p:*)'] } };
const withManifest = (m, sm) => fs.writeFileSync(m.env.BAJZI_MANIFEST, JSON.stringify(Object.assign({}, MANIFEST, { settings_merge: Object.assign({}, MANIFEST.settings_merge, sm) })));

test('overlay: missing prints exactly one note line, not drift, exit 0; --json stays pure JSON', () => {
  const m = machine();
  fs.unlinkSync(path.join(m.home, OVERLAY));
  const r = run(m);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out, 'note: no machine-local settings overlay (~/.claude/bajzi/settings-local.json)\nsetup --check: clean\n');
  assert.deepStrictEqual(JSON.parse(run(m, ['--json']).out), { drift: [] });
});

test('overlay: present entries are merged into the wanted settings (scalars, arrays), BOM tolerated', () => {
  const m = machine();
  fs.writeFileSync(path.join(m.home, OVERLAY), '\uFEFF' + JSON.stringify({ theme: 'light', autoMode: { environment: ['$defaults', '[x] one'] } }));
  let r = run(m);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DRIFT setting-drift theme is "dark", want "light"$/m);
  assert.match(r.out, /^DRIFT setting-drift autoMode\.environment missing "\$defaults"$/m);
  assert.match(r.out, /^DRIFT setting-drift autoMode\.environment missing "\[x\] one"$/m);
  assert.doesNotMatch(r.out, /^note:/m);
  edit(m, '.claude/settings.json', v => { v.theme = 'light'; v.autoMode = { environment: ['$defaults', '[x] one'] }; });
  assert.strictEqual(run(m).out, 'setup --check: clean\n');
});

test('overlay: unparseable = one DRIFT settings-overlay unreadable line, no crash', () => {
  const m = machine();
  fs.writeFileSync(path.join(m.home, OVERLAY), '{ nope');
  const r = run(m);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^DRIFT settings-overlay unreadable$/m);
  assert.match(r.out, /setup --check: 1 drift item\(s\)\n$/);
  assert.strictEqual(r.err, '');
});

test('overlay: stale same-tag entry in settings is reported with its first 60 chars; untagged extras are not', () => {
  const m = machine();
  fs.writeFileSync(path.join(m.home, OVERLAY), JSON.stringify({ autoMode: { allow: ['$defaults', '[owner] new rule'] } }));
  const old = '[owner] old narrowed rule ' + 'x'.repeat(80);
  edit(m, '.claude/settings.json', v => { v.autoMode = { allow: ['$defaults', '[owner] new rule', old, 'user prose'] }; });
  const r = run(m);
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.split('\n').includes(`DRIFT setting-drift autoMode.allow stale ${old.slice(0, 60)}`));
  assert.doesNotMatch(r.out, /user prose/);
  assert.match(r.out, /setup --check: 1 drift item\(s\)\n$/);
});

test('public autoMode rule: manifest drift is reported; stale old [bajzi] rule too', () => {
  const m = machine();
  withManifest(m, AUTO);
  let r = run(m);
  assert.match(r.out, /^DRIFT setting-drift autoMode\.allow missing "\[bajzi\] rule v2"$/m);
  assert.match(r.out, /^DRIFT setting-drift permissions\.allow missing "Bash\(glm -p:\*\)"$/m);
  edit(m, '.claude/settings.json', v => { v.autoMode = { allow: ['$defaults', '[bajzi] rule v1', '[bajzi] rule v2'] }; v.permissions.allow = ['Bash(glm -p:*)']; });
  r = run(m);
  assert.match(r.out, /^DRIFT setting-drift autoMode\.allow stale \[bajzi\] rule v1$/m);
  edit(m, '.claude/settings.json', v => { v.autoMode.allow = ['$defaults', '[bajzi] rule v2']; });
  assert.strictEqual(run(m).out, 'setup --check: clean\n');
});

test('real manifest: public autoMode rule, no broad glm -p allow rule, nothing trips forbidden_leftovers', () => {
  const real = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8'));
  const sm = real.settings_merge;
  assert.strictEqual(sm.permissions.defaultMode, 'auto');
  assert.strictEqual(sm.autoMode.allow[0], '$defaults');
  assert.strictEqual(sm.autoMode.allow.length, 2);
  assert.match(sm.autoMode.allow[1], /^\[bajzi\] saver-mode worker: .*`glm -p`/);
  // no allow rule may pre-approve a bypassPermissions / skip-permissions glm -p run that has no --settings deny list
  const risky = ['glm -p "x" --permission-mode bypassPermissions', 'glm -p "x" --dangerously-skip-permissions'];
  for (const e of sm.permissions.allow || []) {
    const mm = /^Bash\((.*?)(:\*|\*)?\)$/.exec(e);
    if (mm) for (const c of risky) assert.ok(!c.startsWith(mm[1].trim()) || /--settings/.test(e), `${e} approves: ${c}`);
  }
  const hay = JSON.stringify(sm.autoMode) + JSON.stringify(sm.permissions.allow || []);
  for (const s of real.forbidden_leftovers.settings_substrings) assert.ok(!hay.includes(s), s);
});

const MP = '.claude/plugins/marketplaces/bajzi-plugins/shared/CLAUDE.md';
const writeRules = (m, rel, text) => { const p = path.join(m.home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

test('global rules: source missing = skipped silently', () => {
  const m = machine();
  assert.strictEqual(run(m).out, 'setup --check: clean\n');
});

test('global rules: each missing ## heading is drift; present headings (CRLF ok) are clean; no ~/.claude/CLAUDE.md = all missing', () => {
  const m = machine();
  writeRules(m, MP, '# t\n## One\nbody\n## Two\nbody\n### Sub\n');
  let r = run(m);
  assert.match(r.out, /^DRIFT global-rules missing "## One"$/m);
  assert.match(r.out, /^DRIFT global-rules missing "## Two"$/m);
  assert.doesNotMatch(r.out, /Sub/);
  writeRules(m, '.claude/CLAUDE.md', 'x\r\n## One\r\nmine\r\n');
  r = run(m);
  assert.doesNotMatch(r.out, /missing "## One"/);
  assert.match(r.out, /^DRIFT global-rules missing "## Two"$/m);
  writeRules(m, '.claude/CLAUDE.md', '## One\n## Two\n');
  assert.strictEqual(run(m).out, 'setup --check: clean\n');
});

test('SKILL.md apply phase documents overlay merge and global-rules append', () => {
  const t = fs.readFileSync(SKILL, 'utf8');
  assert.match(t, /settings-local\.json/);
  assert.match(t, /\$defaults/);
  assert.match(t, /same-tag|same `\[tag\]`/);
  assert.match(t, /temp file/);
});

// addon_marketplaces (~/.claude/bajzi/config.json): listed add-on marketplaces are never "extra".
function addonMachine(list) {
  const m = machine();
  edit(m, '.claude/bajzi/config.json', v => { v.addon_marketplaces = list; });
  edit(m, '.claude/plugins/known_marketplaces.json', v => {
    v['my-addons'] = { source: { source: 'github', repo: 'someone/my-addons' } };
  });
  edit(m, '.claude/plugins/installed_plugins.json', v => { v.plugins['y@my-addons'] = [{ scope: 'user' }]; });
  return m;
}

test('addon_marketplaces: a listed marketplace and its plugin are clean', () => {
  const r = run(addonMachine(['my-addons']));
  assert.strictEqual(r.out, 'setup --check: clean\n');
  assert.strictEqual(r.code, 0);
});

test('addon_marketplaces: unlisted marketplace/plugin still drift; x@other drifts, y@listed does not', () => {
  const m = addonMachine(['my-addons']);
  edit(m, '.claude/plugins/known_marketplaces.json', v => { v.other = { source: { source: 'github', repo: 'a/other' } }; });
  edit(m, '.claude/plugins/installed_plugins.json', v => { v.plugins['x@other'] = [{ scope: 'user' }]; });
  const r = run(m);
  assert.match(r.out, /^DRIFT marketplace-extra other$/m);
  assert.match(r.out, /^DRIFT plugin-extra x@other$/m);
  assert.doesNotMatch(r.out, /my-addons|y@/);
  assert.match(r.out, /2 drift item\(s\)/);
});

test('addon_marketplaces: no list or no config.json = extras still reported, no bajzi-config line', () => {
  const m = addonMachine(['my-addons']);
  edit(m, '.claude/bajzi/config.json', v => { delete v.addon_marketplaces; });
  let r = run(m);
  assert.match(r.out, /^DRIFT marketplace-extra my-addons$/m);
  assert.match(r.out, /^DRIFT plugin-extra y@my-addons$/m);
  assert.doesNotMatch(r.out, /bajzi-config/);
  fs.rmSync(path.join(m.home, '.claude/bajzi/config.json'));
  r = run(m);
  assert.match(r.out, /^DRIFT marketplace-extra my-addons$/m);
  assert.match(r.out, /^DRIFT plugin-extra y@my-addons$/m);
  assert.doesNotMatch(r.out, /bajzi-config/);
});

test('addon_marketplaces: an invalid value is one bajzi-config drift and extras are still reported', () => {
  for (const bad of ['my-addons', 5, null, ['my-addons', '-bad'], ['ok', 3], ['a b']]) {
    const m = addonMachine(bad);
    const r = run(m);
    assert.strictEqual(r.code, 1, JSON.stringify(bad));
    assert.strictEqual(r.out.match(/^DRIFT bajzi-config addon_marketplaces invalid$/gm).length, 1, JSON.stringify(bad));
    assert.match(r.out, /^DRIFT marketplace-extra my-addons$/m);
    assert.match(r.out, /^DRIFT plugin-extra y@my-addons$/m);
  }
});

test('addon_marketplaces: an unparseable config.json gives no bajzi-config line (reviewer-models-invalid reports it)', () => {
  const m = addonMachine(['my-addons']);
  fs.writeFileSync(path.join(m.home, '.claude/bajzi/config.json'), '{nope');
  const r = run(m);
  assert.doesNotMatch(r.out, /bajzi-config/);
  assert.match(r.out, /^DRIFT reviewer-models-invalid /m);
  assert.match(r.out, /^DRIFT marketplace-extra my-addons$/m);
});

test('SKILL.md: add-on gate, exact extra lines, and step 11 keeps other config keys', () => {
  const s = fs.readFileSync(SKILL, 'utf8');
  assert.match(s, /addon_marketplaces/);
  assert.match(s, /`bajzi-config`/);
  assert.match(s, /EXACTLY the `plugin-extra`/);
  assert.match(s, /\.\.\.cur/);
});

test('SKILL.md step 11 one-liner keeps the other keys of an existing config.json', () => {
  const sk = fs.readFileSync(SKILL, 'utf8');
  const script = /^ {4}node -e "(.*)" "\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/setup\/manifest\.json"$/m.exec(sk)[1];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-s11-'));
  const f = path.join(home, '.claude', 'bajzi', 'config.json');
  const go = () => spawnSync(process.execPath, ['-e', script, REAL_MANIFEST], { env: Object.assign({}, process.env, { BAJZI_HOME: home }), encoding: 'utf8' });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ language: 'hu', addon_marketplaces: ['my-addons'] }));
  const r = go();
  assert.strictEqual(r.status, 0, r.stderr);
  const v = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(v.language, 'hu');
  assert.deepStrictEqual(v.addon_marketplaces, ['my-addons']);
  assert.ok(Array.isArray(v.reviewer_models) && v.reviewer_models.length);
  // unparseable file with an add-on entry: not silently lost, a copy is kept and reported
  const broken = '{"addon_marketplaces": ["my-addons"],}';
  fs.writeFileSync(f, broken);
  const r2 = go();
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(fs.readFileSync(f + '.bak', 'utf8'), broken);
  assert.match(r2.stderr, /config\.json\.bak/);
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).reviewer_models);
});
