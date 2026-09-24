'use strict';
// T3 (agents-and-cadence plan): contract test for the reviewer + fixer agent bodies. It runs the
// REAL agents through `claude -p` (plugin loaded from this checkout via --plugin-dir, session run
// as the agent via --agent), so it needs a logged-in Claude subscription, takes minutes and costs
// quota. Skipped unless BAJZI_CONTRACT=1, so the normal node suite stays offline.
//   BAJZI_CONTRACT=1 TMP=D:/t3h node --test bajzi/agents/tests/contract.test.js
// L0 only: plain `claude` (override with BAJZI_CONTRACT_CLAUDE), never the glm/ccr/worker shims.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const findings = require('../../lib/findings.js');

const PLUGIN_DIR = path.join(__dirname, '..', '..');
const CLAUDE = process.env.BAJZI_CONTRACT_CLAUDE || 'claude';
const SLICE = 'cart-coupon';
// The outer `node --test` sets NODE_TEST_CONTEXT; inherited by a child `node --test` (the fixer's
// test command, our own green check) it makes that child skip every file silently.
const ENV = { ...process.env };
delete ENV.NODE_TEST_CONTEXT;

// Fixture repo. Base: a tested cart total. Tip adds applyCoupon with two planted defects:
// (1) money: the 50% cap is computed and then ignored, so a 100% coupon makes the order free and
// a 150% coupon a negative charge; (2) nit: a typo in the new comment ("teh").
const BASE_CART = `'use strict';
// Returns the cart total in cents for a list of {priceCents, qty}.
function total(items) {
  return items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
}

module.exports = { total };
`;
const TIP_CART = `'use strict';
// Returns the cart total in cents for a list of {priceCents, qty}.
function total(items) {
  return items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
}

// Applies a percentage coupon to teh total in cents. Coupons are capped at 50%.
function applyCoupon(totalCents, percent) {
  const capped = Math.min(percent, 50);
  return totalCents - Math.round((totalCents * percent) / 100);
}

module.exports = { total, applyCoupon };
`;
const CART_TEST = `'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { total } = require('./cart.js');

test('total sums price x qty in cents', () => {
  assert.strictEqual(total([{ priceCents: 250, qty: 2 }, { priceCents: 100, qty: 1 }]), 600);
});
`;
// Hidden oracle, never in the fixture repo: the money defect is really gone after the fixer.
const ORACLE = `const { applyCoupon } = require(process.argv[2]);
const a = require('node:assert');
a.strictEqual(applyCoupon(1000, 20), 800);
a.strictEqual(applyCoupon(1000, 100), 500);
a.strictEqual(applyCoupon(1000, 150), 500);
console.log('oracle ok');
`;

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} -> ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
function git(cwd, ...args) {
  return sh(cwd, 'git', ['-c', 'user.name=contract', '-c', 'user.email=contract@example.invalid',
    '-c', 'core.autocrlf=false', ...args]);
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

// The reviewer's final message is the findings file plus a last `VERDICT:` line (it has no Write
// tool); the caller drops that line before writing/validating the file.
function splitVerdict(text) {
  const lines = text.trim().split(/\r?\n/);
  const last = lines[lines.length - 1].trim();
  assert.match(last, /^VERDICT: (CLEAN|FINDINGS \d+)$/, `reviewer last line: ${last}`);
  return { file: `${lines.slice(0, -1).join('\n').trim()}\n`, verdict: last };
}

const skip = process.env.BAJZI_CONTRACT === '1' ? false : 'set BAJZI_CONTRACT=1 (calls claude -p)';

test('reviewer + fixer contract on a two-defect fixture repo', { skip, timeout: 1500e3 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bajzi-contract-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'cart.js'), BASE_CART);
  fs.writeFileSync(path.join(repo, 'cart.test.js'), CART_TEST);
  git(repo, 'add', 'cart.js', 'cart.test.js');
  git(repo, 'commit', '-qm', 'cart total');
  const base = git(repo, 'rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(repo, 'cart.js'), TIP_CART);
  git(repo, 'commit', '-qam', 'coupon');
  const tip = git(repo, 'rev-parse', '--short', 'HEAD');
  const diff = git(repo, 'diff', `${base}..${tip}`);

  // --- reviewer, round 1 ---
  const rev = runAgent(repo, 'reviewer', [
    `slice_id: ${SLICE}`, 'round: 1', `range: ${base}..${tip}`, 'changed files:', '- cart.js',
    'diff:', diff, ''].join('\n'), ['--max-turns', '12']);
  assert.ok(rev.models.some((x) => /opus/.test(x)), `reviewer served ${rev.models}, not opus`);
  const { file, verdict } = splitVerdict(rev.result);
  fs.mkdirSync(path.join(root, 'findings'));
  const r1 = path.join(root, 'findings', `${SLICE}-r1.md`);
  fs.writeFileSync(r1, file);
  const v = findings.validate(file);
  assert.ok(v.ok, `findings file invalid: ${v.errors.join('; ')}\n${file}`);
  assert.strictEqual(v.doc.slice, SLICE);
  assert.strictEqual(verdict, `VERDICT: ${v.doc.header.verdict}`);
  const fs1 = v.doc.findings;
  const money = fs1.find((f) => f.file === 'cart.js' && ['major', 'blocker'].includes(f.severity)
    && /cap|50|percent|coupon/i.test(f.finding));
  assert.ok(money, `money defect not rated >= major: ${fs1.map((f) => f.heading).join(' | ')}`);
  const nit = fs1.find((f) => /typo|teh|spell/i.test(`${f.finding} ${f.why_severity}`));
  assert.ok(nit, `typo nit not reported: ${fs1.map((f) => f.heading).join(' | ')}`);

  // --- fixer, on the severity-free copy ---
  const fixerCopy = findings.stripForFixer(file);
  assert.doesNotMatch(fixerCopy, /· (blocker|major|minor|nit) ·|^(if_unfixed|why_severity):/m);
  const fix = runAgent(repo, 'fixer', [
    `slice: ${SLICE}`, 'slice files: cart.js, cart.test.js', 'test command: node --test', '',
    fixerCopy].join('\n'),
  ['--max-turns', '30', '--permission-mode', 'acceptEdits', '--allowedTools',
    'Bash(node --test)', 'Bash(node --test:*)', 'Bash(touch:*)', 'Bash(git diff:*)', 'Bash(git status:*)']);
  assert.ok(fix.models.some((x) => /sonnet/.test(x)), `fixer served ${fix.models}, not sonnet`);
  const m = fix.result.match(/^FIX (\S+) DONE (\d+)\/(\d+)\s*$/m);
  assert.ok(m, `fixer report has no "FIX <slice> DONE <fixed>/<total>" line:\n${fix.result}`);
  assert.strictEqual(m[1], SLICE);
  assert.strictEqual(Number(m[3]), fs1.length, 'fixer total != number of findings');
  const marks = findings.parseFixerReport(fix.result);
  assert.strictEqual(marks.size, Number(m[3]) - Number(m[2]), 'untouched lines != total - fixed');
  for (const id of marks.keys()) assert.ok(fs1.some((f) => f.id === id), `unknown id ${id}`);
  const t = spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8', env: ENV });
  assert.strictEqual(t.status, 0, `fixture tests not green after fix:\n${t.stdout}`);
  fs.writeFileSync(path.join(root, 'oracle.js'), ORACLE);
  sh(root, 'node', [path.join(root, 'oracle.js'), path.join(repo, 'cart.js')]);
  assert.match(fs.readFileSync(path.join(repo, 'cart.js'), 'utf8'), /the total/);

  const record = {
    root, reviewer: { models: rev.models, turns: rev.turns, cost: rev.cost, verdict },
    findings: fs1.map((f) => `${f.id} ${f.severity} ${f.location}`),
    fixer: { models: fix.models, turns: fix.turns, cost: fix.cost, report: fix.result.trim() },
  };
  fs.writeFileSync(path.join(root, 'contract-result.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
});
