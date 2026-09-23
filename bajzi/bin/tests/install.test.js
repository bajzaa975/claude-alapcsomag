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
function install(home) {
  const r = spawnSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, BAJZI_HOME: home }),
  });
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
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('second run changes nothing: same mtimes, no backup file', () => {
  const { home, dst } = decoy();
  try {
    install(home);
    const before = Object.keys(SRC).map((f) => fs.statSync(path.join(dst, f)).mtimeMs);
    install(home);
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
