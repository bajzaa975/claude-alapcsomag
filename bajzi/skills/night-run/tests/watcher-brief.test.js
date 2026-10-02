'use strict';
// WATCHER-BRIEF.md.tmpl: the triage tick's duties and guardrails (duty 4 = blocking-failure fix).
// Phrase assertions on whitespace-collapsed text, never a whole-file snapshot.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'templates', 'WATCHER-BRIEF.md.tmpl'), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const TEXT = flat(RAW);
const has = (hay, phrase) => assert.ok(hay.includes(phrase), `missing: ${phrase}`);

const dutiesBlock = () => {
  const start = RAW.indexOf('## Duties');
  const end = RAW.indexOf('## Output contract');
  assert.ok(start >= 0 && end > start, 'Duties and Output contract sections present');
  return RAW.slice(start, end);
};
const duty4 = () => {
  const block = dutiesBlock();
  const start = block.search(/^4\. \*\*Fix a BLOCKING/m);
  const end = block.search(/^5\. \*\*Rule of two/m);
  assert.ok(start >= 0 && end > start, 'duty 4 sits between its heading and duty 5 Rule of two');
  return flat(block.slice(start, end));
};

test('line 5: the sprint-work ban is replaced by the duty-4 exception', () => {
  assert.ok(!TEXT.includes("you do not run the sprint's work"), 'old phrase still present');
  has(TEXT, "You do not poll, you do not wait, and you never do a sprint's story work: the only code you may change is the blocking-failure fix in duty 4.");
});

test('duties are numbered 1-6 in order', () => {
  const nums = [...dutiesBlock().matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.deepStrictEqual(nums, [1, 2, 3, 4, 5, 6]);
  const block = flat(dutiesBlock());
  has(block, '5. **Rule of two**');
  has(block, '6. **Queue finished**');
});

test('duty 1 has the BLOCKING class after ANOMALY', () => {
  const block = flat(dutiesBlock());
  const anomaly = block.indexOf('- ANOMALY:');
  const blocking = block.indexOf('- BLOCKING (an ANOMALY that stops the whole queue):');
  assert.ok(anomaly >= 0 && blocking > anomaly, 'BLOCKING bullet after ANOMALY');
  has(block, 'the runner aborted (`aborted: baseline RED ...`), the baseline gate is RED before any sprint ran, or a tool/PATH breakage fails every session.');
  has(block, "A runner `summary:` line after an abort is NOT 'queue finished'.");
});

test('duty 3 escalates outside the allowlist and duty 4; its never-list is unchanged', () => {
  has(TEXT, 'Anything outside the allowlist and duty 4:');
  has(TEXT, 'Never push, never touch main, never edit runner scripts, hooks, settings or git history, never kill a session younger than 45 minutes.');
});

test('duty 4 fixes only a proven environment / test-harness cause inside the project', () => {
  const d = duty4();
  has(d, '**Fix a BLOCKING failure whose cause is the environment or the test harness**');
  has(d, 'only when duty 2 proved that cause with evidence');
  has(d, 'never product code');
  has(d, 'Never edit runner scripts, hooks, settings, CI config or anything outside the project.');
});

test('duty 4 never makes the gate green by testing less', () => {
  const d = duty4();
  has(d, 'Never delete a test');
  has(d, 'never remove or loosen an assertion, a check or a gate threshold');
  has(d, 'never mark a failing test expected-to-fail');
  has(d, 'Skip a test only when it cannot run on this machine at all, and write that reason next to the skip.');
  has(d, 'A change that turns the gate green by testing less is not a fix: ESCALATE instead.');
});

test('duty 4 re-runs exactly the failed checks, not the whole gate', () => {
  const d = duty4();
  has(d, 'Re-run exactly the failed checks / test ids from the gate log; all must pass.');
  has(d, 'Do not run the whole gate');
});

test('duty 4 commit rules: branch, no live session, staged paths, no push/amend', () => {
  const d = duty4();
  has(d, 'if HEAD is main or detached, do not commit — ESCALATE.');
  has(d, 'Commit only when no runner or sprint session is alive (re-list the processes first).');
  has(d, 'never `git add -A` or `.`');
  has(d, 'message `night-watch fix: <cause>`');
  has(d, 'Never push, never amend, never touch history.');
});

test('duty 4 hands relaunch, summary and review-queue to tier 0', () => {
  const d = duty4();
  has(d, 'Do not relaunch, do not write the summary entry, do not open a review-queue item: tier 0 does all three.');
});

test('duty 4 ends with the exact TICK FIXED form; fp=none never relaunches', () => {
  const d = duty4();
  has(d, 'End the tick with exactly `TICK FIXED fp=<fingerprint from the abort line in the facts, or none> commit=<full 40-char sha>`.');
  has(d, 'Tier 0 relaunches ONLY for a runner abort with a fingerprint: with `fp=none` the commit stands and tier 0 logs it, but nothing relaunches');
  has(d, 'Do not expect a relaunch.');
  has(d, 'Cause not environmental/test-harness, not proven, or the fix needs a forbidden path: no commit, `ESCALATE` with the evidence.');
});

test('output contract lists FIXED and keeps its two closing sentences', () => {
  has(TEXT, 'Every tick ends with exactly one line on stdout: `TICK <OK|ACTION|FIXED|ESCALATE|SUMMARY> <one sentence>`; FIXED uses the exact form of duty 4.');
  has(TEXT, 'Never claim an action you did not verify (re-read the file, re-list the process).');
  has(TEXT, 'A wrong "fixed" costs the morning more than an honest "could not".');
});

test('every placeholder the renderers fill is still present', () => {
  for (const p of ['EVENT', 'FACTS', 'RUNNER', 'PROJECT', 'RUN_DIR', 'RUN_LOG', 'TERMINAL_LINE_REGEX',
    'PROMPT_TEMPLATE', 'LAUNCH_LINE', 'LEVEL', 'STATE_FILE', 'SUMMARY_FILE', 'ESCALATION_MODEL', 'ALLOWLIST']) {
    has(RAW, `{{${p}}}`);
  }
});
