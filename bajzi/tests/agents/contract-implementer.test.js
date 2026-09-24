'use strict';
// T4 (agents-and-cadence plan): contract test for the implementer agent body. Runs the REAL agent
// through `claude -p` (plugin loaded from this checkout via --plugin-dir, session run as the agent
// via --agent), so it needs a logged-in Claude subscription, takes minutes and costs quota.
// Skipped unless BAJZI_CONTRACT=1, so the normal node suite stays offline.
//   BAJZI_CONTRACT=1 TMP=D:/t4h/tmp node --test bajzi/tests/agents/contract-implementer.test.js
// L0 only: plain `claude` (override with BAJZI_CONTRACT_CLAUDE), never the glm/ccr/worker shims.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_DIR = path.join(__dirname, '..', '..');
const CLAUDE = process.env.BAJZI_CONTRACT_CLAUDE || 'claude';
const SLICE = 'clamp-util';
// The outer `node --test` sets NODE_TEST_CONTEXT; inherited by a child `node --test` (the slice's
// test command, our own green check) it makes that child skip every file silently.
const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT;

// Fixture repo: an empty math-utils module and a Tier-2 slice (docs/slice-format.md) asking for a
// clamp() function, tests included, nothing else touched.
const BASE_UTILS = `'use strict';
module.exports = {};
`;
const SLICE_FILE = `# Slice · ${SLICE}
tier: 2
files: mathutils.js, mathutils.test.js
acceptance: clamp(value, min, max) returns min when value < min, max when value > max, and value otherwise
test: node --test
`;
// Hidden oracle, never in the fixture repo: clamp really works after the implementer runs.
const ORACLE = `const { clamp } = require(process.argv[2]);
const a = require('node:assert');
a.strictEqual(clamp(5, 1, 10), 5);
a.strictEqual(clamp(-1, 1, 10), 1);
a.strictEqual(clamp(20, 1, 10), 10);
console.log('oracle ok');
`;

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

// One headless session run AS the agent. Returns {result, models, turns, cost}.
function runAgent(cwd, agent, prompt, extra) {
  const args = ['-p', '--plugin-dir', PLUGIN_DIR, '--agent', `bajzi:${agent}`,
    '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence', ...extra];
  const r = spawnSync(CLAUDE, args, { cwd, input: prompt, encoding: 'utf8', timeout: 600e3, env: ENV,
    maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(cwd, '..', `${agent}.out.json`), `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.status, 0, `${agent}: claude exit ${r.status} ${r.error || ''} ${r.stderr}`);
  const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  return { result: j.result || '', models: Object.keys(j.modelUsage || {}), turns: j.num_turns,
    cost: j.total_cost_usd, isError: j.is_error };
}

const skip = process.env.BAJZI_CONTRACT === '1' ? false : 'set BAJZI_CONTRACT=1 (calls claude -p)';

test('implementer contract on a one-function fixture slice', { skip, timeout: 900e3 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-contract-impl-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'mathutils.js'), BASE_UTILS);
  // A git repo with a base commit, so scope ("only files: paths changed, no commit") is checkable.
  sh(repo, 'git', ['init', '-q']);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(repo, 'git', ['config', k, v]);
  sh(repo, 'git', ['add', '--', 'mathutils.js']);
  sh(repo, 'git', ['commit', '-q', '-m', 'base']);
  const base = sh(repo, 'git', ['rev-parse', 'HEAD']);

  // The production brief: /bajzi:implement passes the slice file verbatim, nothing else (dispatch.md).
  const run = runAgent(repo, 'implementer', SLICE_FILE,
    ['--max-turns', '20', '--permission-mode', 'acceptEdits', '--allowedTools',
      'Bash(node --test)', 'Bash(node --test:*)']);
  assert.ok(run.models.some((x) => /sonnet/.test(x)), `implementer served ${run.models}, not sonnet`);

  // docs/slice-format.md "Agent report": the message ends with the SLICE line, then one changed
  // path per line and nothing else; anything before the SLICE line is ignored.
  const files = SLICE_FILE.match(/^files: (.*)$/m)[1].split(',').map((f) => f.trim());
  const lines = run.result.trim().split(/\r?\n/);
  const at = lines.findIndex((l) => /^SLICE \S+ (DONE|BLOCKED)/.test(l));
  assert.ok(at >= 0, `implementer report has no SLICE line:\n${run.result}`);
  assert.strictEqual(lines[at], `SLICE ${SLICE} DONE`, `not DONE:\n${run.result}`);
  const listed = lines.slice(at + 1).map((l) => l.trim());
  assert.ok(listed.length > 0, 'DONE report lists no files');

  assert.strictEqual(sh(repo, 'git', ['rev-parse', 'HEAD']), base, 'the implementer committed');
  const changed = [...sh(repo, 'git', ['diff', '--name-only', base]).split(/\r?\n/),
    ...sh(repo, 'git', ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/)].filter(Boolean);
  for (const f of changed) assert.ok(files.includes(f), `changed outside files: (${files}): ${f}`);
  for (const f of listed) assert.ok(changed.includes(f), `report lists ${JSON.stringify(f)}, not a changed path (${changed})`);
  for (const f of changed) assert.ok(listed.includes(f), `changed ${f} missing from the report`);

  const t = spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8', env: ENV });
  assert.strictEqual(t.status, 0, `fixture tests not green after implement:\n${t.stdout}`);
  fs.writeFileSync(path.join(root, 'oracle.js'), ORACLE);
  sh(root, 'node', [path.join(root, 'oracle.js'), path.join(repo, 'mathutils.js')]);

  const record = { root, implementer: { models: run.models, turns: run.turns, cost: run.cost,
    report: run.result.trim() } };
  fs.writeFileSync(path.join(root, 'contract-result.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
});
