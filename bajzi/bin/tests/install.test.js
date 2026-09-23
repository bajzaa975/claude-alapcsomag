'use strict';
// install.sh against a DECOY home only (HOME/USERPROFILE/BAJZI_HOME -> mktemp dir); never the real ~/.local/bin.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const BIN = path.join(__dirname, '..');
const INSTALL = path.join(BIN, 'install.sh');
const LAUNCHERS = ['worker', 'worker.cmd', 'glm', 'glm.cmd', 'ccr', 'ccr.cmd'];
const SRC = Object.fromEntries([
  ['cc-router.js', path.join(BIN, 'cc-router.js')],
  ...LAUNCHERS.map((f) => [f, path.join(BIN, 'launchers', f)]),
]);

function decoy() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-install-'));
  return { home, dst: path.join(home, '.local', 'bin') };
}
// NODE_TEST_CONTEXT is dropped: inherited, it makes install.sh's own `node --test` gate skip its files
// and exit 0, so the gate would never really run here.
function run(home, script = INSTALL) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, BAJZI_HOME: home });
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('bash', [script], { encoding: 'utf8', env });
}
function install(home) {
  const r = run(home);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  return r;
}
const bytes = (p) => fs.readFileSync(p);
const baks = (dst) => fs.readdirSync(dst).filter((f) => f.endsWith('.bak')).sort();

test('fresh install: all seven files byte-identical to the repo copies, no backups', () => {
  const { home, dst } = decoy();
  try {
    install(home);
    for (const [f, src] of Object.entries(SRC)) assert.ok(bytes(src).equals(bytes(path.join(dst, f))), f);
    assert.deepStrictEqual(baks(dst), []);
    if (process.platform !== 'win32') {  // win32 reports no exec bits
      for (const f of ['worker', 'glm', 'ccr']) assert.ok(fs.statSync(path.join(dst, f)).mode & 0o111, f + ' not executable');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('second run changes nothing: same mtimes, no backup file', () => {
  const { home, dst } = decoy();
  try {
    install(home);
    const before = Object.keys(SRC).map((f) => fs.statSync(path.join(dst, f)).mtimeMs);
    const r = install(home);
    assert.strictEqual((r.stdout.match(/^unchanged: /gm) || []).length, 7, r.stdout);
    const after = Object.keys(SRC).map((f) => fs.statSync(path.join(dst, f)).mtimeMs);
    assert.deepStrictEqual(after, before);
    assert.deepStrictEqual(baks(dst), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an existing DIFFERENT file is kept as <name>.bak before being replaced; identical ones get no .bak', () => {
  const { home, dst } = decoy();
  try {
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'glm'), 'old glm\n');
    fs.writeFileSync(path.join(dst, 'cc-router.js'), 'old router\n');
    fs.copyFileSync(SRC['worker.cmd'], path.join(dst, 'worker.cmd'));
    install(home);
    assert.deepStrictEqual(baks(dst), ['cc-router.js.bak', 'glm.bak']);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'glm.bak'), 'utf8'), 'old glm\n');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'cc-router.js.bak'), 'utf8'), 'old router\n');
    for (const [f, src] of Object.entries(SRC)) assert.ok(bytes(src).equals(bytes(path.join(dst, f))), f);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a failed backup is fatal: non-zero exit, the destination keeps its old bytes', () => {
  const { home, dst } = decoy();
  const bak = path.join(dst, 'glm.bak');
  try {
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'glm'), 'OLD GLM\n');
    fs.writeFileSync(bak, 'PREV BAK\n');
    fs.chmodSync(bak, 0o444);  // read-only: the backup copy cannot overwrite it
    const r = run(home);
    assert.notStrictEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /backup of .*glm FAILED/);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'glm'), 'utf8'), 'OLD GLM\n');
    assert.deepStrictEqual(fs.readdirSync(dst).filter((f) => f.includes('.tmp.')), []);
  } finally {
    try { fs.chmodSync(bak, 0o666); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a red cc-router suite refuses the install: nothing is written', () => {
  // A copy of the real install.sh next to a red cc-router.test.js; no production knob involved.
  const { home, dst } = decoy();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-redgate-'));
  try {
    fs.mkdirSync(path.join(bin, 'tests'));
    fs.copyFileSync(INSTALL, path.join(bin, 'install.sh'));
    fs.cpSync(path.join(BIN, 'launchers'), path.join(bin, 'launchers'), { recursive: true });
    fs.copyFileSync(SRC['cc-router.js'], path.join(bin, 'cc-router.js'));
    fs.writeFileSync(path.join(bin, 'tests', 'cc-router.test.js'),
      "require('node:test').test('red', () => { throw new Error('red'); });\n");
    const r = run(home, path.join(bin, 'install.sh'));
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, /cc-router tests FAILED - not installed/);
    assert.ok(!fs.existsSync(dst), 'nothing may be installed');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
