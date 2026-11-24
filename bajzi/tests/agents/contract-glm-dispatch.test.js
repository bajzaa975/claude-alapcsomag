'use strict';
// saver-glm-dispatch F1: contract test for the documented GLM fallback command
// (skills/lib/dispatch.md step 3): `glm -p --permission-mode bypassPermissions --settings <lib/worker-deny.settings.json>`
// (plus `--output-format stream-json --verbose` so the tool trace can be read) with the agent body, `---` and the slice on stdin. Needs the glm launcher and a Z.ai key, takes minutes, costs quota.
// Skipped unless BAJZI_CONTRACT=1, so the default suite never calls GLM.
//   BAJZI_CONTRACT=1 node --test bajzi/tests/agents/contract-glm-dispatch.test.js
// Override the launcher with BAJZI_CONTRACT_GLM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GLM = process.env.BAJZI_CONTRACT_GLM || 'glm';
const SLICE = 'clamp-util';
const DENY = path.join(__dirname, '..', '..', 'lib', 'worker-deny.settings.json');
const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT; // else a child `node --test` skips every file silently

const SLICE_FILE = `# Slice · ${SLICE}
tier: 2
files: mathutils.js, mathutils.test.js
acceptance: clamp(value, min, max) returns min when value < min, max when value > max, and value otherwise
test: node --test
`;

const win = process.platform === 'win32';
const q = (a) => (win ? `"${a}"` : a); // Node does not quote argv through the Windows shell
const launch = (glm, deny, opts) => spawnSync(q(glm), ['-p', '--permission-mode', 'bypassPermissions', '--settings', q(deny),
  '--output-format', 'stream-json', '--verbose'], { ...opts, shell: win });

test('launcher receives the deny-file path as one argument when the path has a space', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi glm space-'));
  const stub = path.join(d, 'stub.js');
  fs.writeFileSync(stub, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const deny = path.join(d, 'worker deny.settings.json');
  const r = launch(stub, deny, { encoding: 'utf8', env: ENV, input: '' });
  assert.strictEqual(r.status, 0, `${r.error || ''} ${r.stderr}`);
  const argv = JSON.parse(r.stdout);
  assert.strictEqual(argv[argv.indexOf('--settings') + 1], deny);
});

const skip = process.env.BAJZI_CONTRACT === '1' ? false : 'set BAJZI_CONTRACT=1 (calls glm -p)';

test('documented GLM dispatch command implements a fixture slice and runs its test command', { skip, timeout: 900e3 }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-contract-glm-'));
  fs.writeFileSync(path.join(repo, 'mathutils.js'), "'use strict';\nmodule.exports = {};\n");
  // dispatch.md: agent body without frontmatter, a `---` line, then the brief verbatim.
  const agent = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'implementer.md'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const r = launch(GLM, DENY, { cwd: repo, input: `${agent}\n---\n${SLICE_FILE}`, encoding: 'utf8', timeout: 800e3, env: ENV,
    maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `glm exit ${r.status} ${r.error || ''} ${r.stderr}`);
  // The worker's final wording varies, so read the tool trace: the slice's `test:` command must have run
  // as a Bash call and returned passing output (not a deny), and the fixture must be green afterwards.
  const blocks = r.stdout.split(/\r?\n/).flatMap((l) => { try { return JSON.parse(l).message?.content || []; } catch { return []; } })
    .filter((b) => b && typeof b === 'object');
  const runs = blocks.filter((b) => b.type === 'tool_use' && b.name === 'Bash' && /\bnode --test\b/.test(b.input?.command || ''));
  assert.ok(runs.length, `the slice test command never ran as a Bash call:\n${r.stdout.slice(-4000)}`);
  // TDD: the first run may be red, and the worker may pipe it through tail; one run must end with `fail 0`
  // and no tool error (a deny comes back as an error).
  const outs = runs.map((u) => blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === u.id))
    .map((res) => (res && !res.is_error ? JSON.stringify(res.content ?? '') : ''));
  assert.ok(outs.some((o) => /fail 0\b/.test(o)), `no passing test run: ${outs.join('\n').slice(0, 800)}`);
  const t = spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8', env: ENV });
  assert.strictEqual(t.status, 0, `fixture tests not green:\n${t.stdout}`);
});
