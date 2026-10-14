'use strict';
// saver-glm-dispatch F1: contract test for the documented GLM fallback command
// (skills/lib/dispatch.md step 3): `glm -p --permission-mode bypassPermissions` with the agent body,
// `---` and the slice on stdin. Needs the glm launcher and a Z.ai key, takes minutes, costs quota.
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
const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT; // else a child `node --test` skips every file silently

const SLICE_FILE = `# Slice · ${SLICE}
tier: 2
files: mathutils.js, mathutils.test.js
acceptance: clamp(value, min, max) returns min when value < min, max when value > max, and value otherwise
test: node --test
`;

const skip = process.env.BAJZI_CONTRACT === '1' ? false : 'set BAJZI_CONTRACT=1 (calls glm -p)';

test('documented GLM dispatch command implements a fixture slice and runs its test command', { skip, timeout: 900e3 }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-contract-glm-'));
  fs.writeFileSync(path.join(repo, 'mathutils.js'), "'use strict';\nmodule.exports = {};\n");
  // dispatch.md: agent body without frontmatter, a `---` line, then the brief verbatim.
  const agent = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'implementer.md'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const r = spawnSync(GLM, ['-p', '--permission-mode', 'bypassPermissions'],
    { cwd: repo, input: `${agent}\n---\n${SLICE_FILE}`, encoding: 'utf8', timeout: 800e3, env: ENV,
      maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  assert.strictEqual(r.status, 0, `glm exit ${r.status} ${r.error || ''} ${r.stderr}`);
  const lines = r.stdout.trim().split(/\r?\n/);
  const at = lines.findIndex((l) => l === `SLICE ${SLICE} DONE`);
  assert.ok(at > 0, `no "SLICE ${SLICE} DONE" report after test evidence:\n${r.stdout}`);
  assert.match(lines.slice(0, at).join('\n'), /pass|ok|tests? \d+/i, `no test evidence before the SLICE line:\n${r.stdout}`);
  const t = spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8', env: ENV });
  assert.strictEqual(t.status, 0, `fixture tests not green:\n${t.stdout}`);
});
