'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, stamp } = require('../install-statusline');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', '..');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fwd = p => p.split(path.sep).join('/');
const NOW = new Date(Date.UTC(2026, 8, 23, 10, 15, 0));

test('fresh home: copies statusline + lib and writes statusLine, no backup', () => {
  const home = tmp('bajzi-inst-');
  const r = install({ pluginRoot: PLUGIN_ROOT, home, now: NOW });
  const dest = path.join(home, '.claude', 'bajzi');
  for (const f of ['statusline.js', 'lib/hook-io.js', 'lib/saver-level.js', 'lib/bridge.js', 'lib/peak.js', 'lib/status-parts.js']) {
    assert.ok(fs.existsSync(path.join(dest, f)), f);
  }
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(s.statusLine, { type: 'command', command: `node "${fwd(path.join(dest, 'statusline.js'))}"` });
  assert.ok(!s.statusLine.command.includes('\\'));
  assert.ok(!s.statusLine.command.includes('plugins'));   // never the versioned cache path
  assert.strictEqual(r.backup, null);
  assert.strictEqual(r.settingsChanged, true);
});

test('existing settings: other keys kept, byte-exact backup, old statusLine replaced', () => {
  const home = tmp('bajzi-inst-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const raw = JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'node "x/gsd-statusline.js"' } }, null, 4);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), raw);
  const r = install({ pluginRoot: PLUGIN_ROOT, home, now: NOW });
  assert.strictEqual(r.backup, path.join(home, '.claude', `settings.json.bak-bajzi-${stamp(NOW)}`));
  assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), raw);
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(s.theme, 'dark');
  assert.match(s.statusLine.command, /\/\.claude\/bajzi\/statusline\.js"$/);
});

test('second run: settings unchanged, no new backup, files refreshed', () => {
  const home = tmp('bajzi-inst-');
  install({ pluginRoot: PLUGIN_ROOT, home, now: NOW });
  fs.writeFileSync(path.join(home, '.claude', 'bajzi', 'statusline.js'), '// stale');
  const r = install({ pluginRoot: PLUGIN_ROOT, home, now: new Date(NOW.getTime() + 60000) });
  assert.strictEqual(r.settingsChanged, false);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, '.claude')).filter(n => n.includes('.bak-bajzi-')), []);
  assert.notStrictEqual(fs.readFileSync(path.join(home, '.claude', 'bajzi', 'statusline.js'), 'utf8'), '// stale');
});

test('unparseable settings.json: refuses, touches nothing', () => {
  const home = tmp('bajzi-inst-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ broken');
  assert.throws(() => install({ pluginRoot: PLUGIN_ROOT, home, now: NOW }));
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ broken');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'bajzi')));
});

test('the installed copy runs from ~/.claude/bajzi (relative requires resolve)', () => {
  const home = tmp('bajzi-inst-');
  install({ pluginRoot: PLUGIN_ROOT, home, now: NOW });
  const cwd = tmp('bajzi-nr-');
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
  delete env.CC_WORKER_MODE;
  delete env.ANTHROPIC_BASE_URL;
  const r = spawnSync(process.execPath, [path.join(home, '.claude', 'bajzi', 'statusline.js')],
    { input: JSON.stringify({ workspace: { current_dir: cwd } }), env, encoding: 'utf8', cwd });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^L0/);
});

test('M6: an existing backup with the same stamp is never overwritten', () => {
  const home = tmp('bajzi-inst-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  const taken = `${settings}.bak-bajzi-${stamp(NOW)}`;
  fs.writeFileSync(taken, 'older backup');
  fs.writeFileSync(settings, JSON.stringify({ theme: 'a' }));
  const r1 = install({ pluginRoot: PLUGIN_ROOT, home, now: NOW });
  assert.strictEqual(fs.readFileSync(taken, 'utf8'), 'older backup');
  assert.notStrictEqual(r1.backup, taken);
  assert.strictEqual(fs.readFileSync(r1.backup, 'utf8'), JSON.stringify({ theme: 'a' }));
  fs.writeFileSync(settings, JSON.stringify({ theme: 'b' }));
  const r2 = install({ pluginRoot: PLUGIN_ROOT, home, now: NOW });
  assert.ok(![taken, r1.backup].includes(r2.backup));
  assert.strictEqual(fs.readFileSync(r1.backup, 'utf8'), JSON.stringify({ theme: 'a' }));
  assert.strictEqual(fs.readFileSync(r2.backup, 'utf8'), JSON.stringify({ theme: 'b' }));
});

// ---- refresh(): silent session-start refresh of the installed copy ----
const { refresh } = require('../install-statusline');

function fakePlugin(version, marker = 'v') {
  const root = tmp('bajzi-plug-');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks', 'node', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'bajzi', version }));
  fs.writeFileSync(path.join(root, 'hooks', 'node', 'statusline.js'), `// statusline ${marker}\n`);
  fs.writeFileSync(path.join(root, 'hooks', 'node', 'lib', 'a.js'), `// a ${marker}\n`);
  fs.writeFileSync(path.join(root, 'hooks', 'node', 'lib', 'b.js'), `// b ${marker}\n`);
  return root;
}
const readDest = (home, f) => fs.readFileSync(path.join(home, '.claude', 'bajzi', f), 'utf8');
const leftovers = home => {
  const out = [];
  const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name.endsWith('.tmp')) out.push(p); } };
  walk(path.join(home, '.claude'));
  return out;
};

test('refresh: no installed copy -> nothing created', () => {
  const home = tmp('bajzi-ref-');
  const r = refresh({ pluginRoot: fakePlugin('1.2.3'), home });
  assert.deepStrictEqual(r, { refreshed: false, reason: 'not-installed' });
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('refresh: stale copy -> files updated, stamp written, settings.json byte-identical, no tmp left', () => {
  const home = tmp('bajzi-ref-');
  const dest = path.join(home, '.claude', 'bajzi');
  fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'statusline.js'), '// old');
  fs.writeFileSync(path.join(dest, 'lib', 'a.js'), '// old');
  const settings = path.join(home, '.claude', 'settings.json');
  const raw = '{ "theme":"dark",\n "statusLine": {"x":1} }';
  fs.writeFileSync(settings, raw);
  const r = refresh({ pluginRoot: fakePlugin('1.2.3'), home });
  assert.strictEqual(r.refreshed, true);
  assert.strictEqual(r.version, '1.2.3');
  assert.strictEqual(readDest(home, 'statusline.js'), '// statusline v\n');
  assert.strictEqual(readDest(home, 'lib/a.js'), '// a v\n');
  assert.strictEqual(readDest(home, 'lib/b.js'), '// b v\n');
  assert.strictEqual(readDest(home, 'statusline.version').trim(), '1.2.3');
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), raw);
  assert.deepStrictEqual(leftovers(home), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, '.claude')).sort(), ['bajzi', 'settings.json']);
});

test('refresh: identical copy -> no write (refreshed:false, mtime unchanged)', () => {
  const home = tmp('bajzi-ref-');
  const root = fakePlugin('1.2.3');
  install({ pluginRoot: root, home, now: NOW });
  const files = ['statusline.js', 'lib/a.js', 'statusline.version'].map(f => path.join(home, '.claude', 'bajzi', f));
  const old = new Date(Date.UTC(2020, 0, 1));
  for (const f of files) fs.utimesSync(f, old, old);
  const r = refresh({ pluginRoot: root, home });
  assert.strictEqual(r.refreshed, false);
  for (const f of files) assert.strictEqual(fs.statSync(f).mtimeMs, old.getTime());
});

test('refresh: stamp newer than the running plugin -> no overwrite (no downgrade)', () => {
  const home = tmp('bajzi-ref-');
  install({ pluginRoot: fakePlugin('1.10.0', 'new'), home, now: NOW });
  const r = refresh({ pluginRoot: fakePlugin('1.9.9', 'old'), home });
  assert.deepStrictEqual(r, { refreshed: false, reason: 'newer-installed' });
  assert.strictEqual(readDest(home, 'statusline.js'), '// statusline new\n');
  assert.strictEqual(readDest(home, 'statusline.version').trim(), '1.10.0');
});

test('refresh: older or garbage stamp -> refreshed (numeric compare, 1.9.0 < 1.10.0)', () => {
  const home = tmp('bajzi-ref-');
  install({ pluginRoot: fakePlugin('1.9.0', 'old'), home, now: NOW });
  assert.strictEqual(refresh({ pluginRoot: fakePlugin('1.10.0', 'new'), home }).refreshed, true);
  assert.strictEqual(readDest(home, 'statusline.js'), '// statusline new\n');
  fs.writeFileSync(path.join(home, '.claude', 'bajzi', 'statusline.version'), 'garbage');
  assert.strictEqual(refresh({ pluginRoot: fakePlugin('1.10.1', 'newer'), home }).refreshed, true);
  assert.strictEqual(readDest(home, 'statusline.js'), '// statusline newer\n');
  assert.strictEqual(readDest(home, 'statusline.version').trim(), '1.10.1');
});

test('install(): writes the version stamp and leaves no tmp files', () => {
  const home = tmp('bajzi-ref-');
  install({ pluginRoot: fakePlugin('2.0.1'), home, now: NOW });
  assert.strictEqual(readDest(home, 'statusline.version').trim(), '2.0.1');
  assert.deepStrictEqual(leftovers(home), []);
});

test('refresh: lib files are written before statusline.js', () => {
  const home = tmp('bajzi-ref-');
  const dest = path.join(home, '.claude', 'bajzi');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'statusline.js'), '// old');
  const root = fakePlugin('1.0.0');
  // make lib/b.js unwritable as a regular file: a directory of that name -> rename fails mid-way
  fs.mkdirSync(path.join(dest, 'lib', 'b.js'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'lib', 'b.js', 'keep'), 'x');
  assert.throws(() => refresh({ pluginRoot: root, home }));
  assert.strictEqual(readDest(home, 'statusline.js'), '// old');
  assert.ok(!fs.existsSync(path.join(dest, 'statusline.version')));
  assert.deepStrictEqual(leftovers(home), []);
});

test('CLI refresh: broken plugin root -> empty stdout, exit 0, no tmp left', () => {
  const home = tmp('bajzi-ref-');
  fs.mkdirSync(path.join(home, '.claude', 'bajzi'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'bajzi', 'statusline.js'), '// old');
  const lone = tmp('bajzi-lone-');   // script copied away from any plugin tree -> pluginRoot is bogus
  fs.copyFileSync(path.join(__dirname, '..', 'install-statusline.js'), path.join(lone, 'install-statusline.js'));
  const r = spawnSync(process.execPath, [path.join(lone, 'install-statusline.js'), 'refresh'],
    { env: Object.assign({}, process.env, { BAJZI_HOME: home }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(readDest(home, 'statusline.js'), '// old');
  assert.deepStrictEqual(leftovers(home), []);
});

test('CLI refresh: real plugin, installed copy -> empty stdout, exit 0, copy refreshed', () => {
  const home = tmp('bajzi-ref-');
  fs.mkdirSync(path.join(home, '.claude', 'bajzi'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'bajzi', 'statusline.js'), '// old');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'install-statusline.js'), 'refresh'],
    { env: Object.assign({}, process.env, { BAJZI_HOME: home }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.notStrictEqual(readDest(home, 'statusline.js'), '// old');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'bajzi', 'lib', 'hook-io.js')));
});

test('CLI refresh: no installed copy -> empty stdout, exit 0, nothing created', () => {
  const home = tmp('bajzi-ref-');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'install-statusline.js'), 'refresh'],
    { env: Object.assign({}, process.env, { BAJZI_HOME: home }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(fs.readdirSync(home), []);
});
