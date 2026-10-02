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

test('duty 4 allows no skips at all (F3)', () => {
  const d = duty4();
  has(d, 'never remove or loosen an assertion, a check or a gate threshold');
  has(d, 'never skip, xfail or delete a test');
  has(d, 'If the only way to green is skipping or testing less, ESCALATE.');
  has(d, 'A harness or helper fix that makes a test RUN (e.g. finding Git Bash next to git) is still a fix.');
  assert.ok(!d.includes('Skip a test only when'), 'skip allowance removed');
});

test('duty 4 re-runs exactly the failed checks; the relaunch re-runs everything (F5)', () => {
  const d = duty4();
  has(d, 'Re-run exactly the failed checks / test ids from the gate log; all must pass.');
  has(d, 'the relaunch makes the baseline gate re-run everything');
  assert.ok(!TEXT.includes('fp=none'), 'no fp=none form anywhere');
});

test('duty 4 checks branch, live sessions and fingerprint before any edit (F1, F2a, F2b)', () => {
  const d = duty4();
  const pre = d.indexOf('FIRST, before any edit:');
  assert.ok(pre >= 0, 'precondition step present');
  for (const p of ['HEAD is not main and not detached', 'no runner or sprint session is alive (re-list the processes)',
    'an `aborted: baseline RED fp=<fp> head=<sha>` line']) {
    const i = d.indexOf(p);
    assert.ok(i >= pre, `missing precondition: ${p}`);
    assert.ok(i < d.indexOf('Fix the cause'), `precondition after the edit step: ${p}`);
  }
  has(d, 'A BLOCKING failure without that line: no commit; ESCALATE with the cause and the proposed fix as a diff in the escalation text.');
});

test('duty 4 restores the tree on every exit without a commit (F1)', () => {
  const d = duty4();
  has(d, 'Every exit of duty 4 that ends without a commit restores the changed paths (`git checkout -- <paths>`, remove any new files) and verifies `git status --porcelain` is clean for them.');
});

test('duty 4 commit rules: staged paths, no push/amend', () => {
  const d = duty4();
  has(d, 'never `git add -A` or `.`');
  has(d, 'message `night-watch fix: <cause>`');
  has(d, 'Never push, never amend, never touch history.');
});

test('duty 4 state line, tier 0 owns relaunch/summary/review (F2e)', () => {
  const d = duty4();
  has(d, 'append exactly `<HH:MM> FIXED <fp> <sha> <cause>` to the state file before the final TICK line.');
  has(d, 'Tier 0 relaunches, writes the summary entry and logs `REVIEW DUE: watcher fix commit <sha> (fp=<fp>)`; the tick does none of those.');
  has(d, 'End the tick with exactly `TICK FIXED fp=<fingerprint from the abort line> commit=<full 40-char sha>`.');
  has(d, 'Tier 0 relaunches only on it');
  has(d, 'Cause not environmental/test-harness, not proven, or the fix needs a forbidden path: no commit, `ESCALATE` with the evidence.');
});

test('a BLOCKING event skips duty 3 and goes straight to duty 4 (F4)', () => {
  has(flat(dutiesBlock()), 'A BLOCKING event skips duty 3 entirely (no allowlisted relaunch, no other action) and goes straight to duty 4.');
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
