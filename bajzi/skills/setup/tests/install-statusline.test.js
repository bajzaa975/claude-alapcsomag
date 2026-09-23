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
