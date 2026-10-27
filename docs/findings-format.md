# Findings format

The contract between the `reviewer` agent, the `fixer` agent, the `/bajzi:review`, `/bajzi:fix`
and `/bajzi:debt` skills, and the owner. Parser and close policy: `bajzi/lib/findings.js`
(tests: `bajzi/lib/tests/findings.test.js`). A file the parser rejects is never routed anywhere.

## Review file

One file per review round: `runtime/findings/<slice-id>-r<round>.md`.

```
# Findings · <slice-id> · round <n>
range: <base>..<tip>
reviewer: opus
verdict: FINDINGS 2
files_reviewed: 6

## F1 · blocker · app/billing/retry.py:41
finding: a timed-out payment call is retried without an idempotency key
if_unfixed: a customer whose payment times out can be charged twice
why_severity: blocker - wrong behaviour with data/money effect
test: tests/test_retry.py::test_timeout_is_idempotent (to write)

## F2 · minor · app/core/needs_you.py:88
finding: retry loop duplicated from retry.py
if_unfixed: two copies drift; a later fix lands in one of them
why_severity: minor - duplication, no behaviour change
test: none
```

- Title: `# Findings · <slice-id> · round <n>`, `n` is 1 or 2. The separator is ` · ` (U+00B7).
- Header, all mandatory: `range`, `reviewer`, `verdict`, `files_reviewed`.
- `verdict`: `CLEAN` when no finding other than a test gap is open, else `FINDINGS <n>`, where `n`
  counts the findings that are not test gaps in round 1 and the `open` ones of those in round 2.
- Finding heading: `## <id> · <severity> · <path[:line]>`. Ids are unique within the file. A test
  gap reads `## <id> · test-gap · <path[:line]>`: `why_severity: test-gap - no failing case found;
  <what is untested>`, `test: <test to write> (to write)` (never `none`), and `if_unfixed` describes a
  future regression going unnoticed. Everywhere else the severity is blocker, major, minor or nit.
- Finding fields, all mandatory and non-empty: `finding`, `if_unfixed`, `why_severity`, `test`
  (`none` when no test applies).
- Round 2 only: `status: resolved | open` on every finding. Previous ids keep their id; a new
  finding the fix introduced gets a fresh id.
- One field per line (`key: value`); a non-blank line that is not a field continues the previous
  field. Header fields and `status` may carry a trailing ` # comment`; free-text fields keep `#`.
- Caps: 24 KB (24576 bytes) and 40 findings per file.

`if_unfixed` is what a user or the system experiences if this is never fixed, in one plain
sentence with no code words. The owner judges this line, not the code.

## Severity rubric

`why_severity` names the rubric line it relies on.

- **blocker** - wrong behaviour, security, data loss/corruption, money
- **major** - edge-case bug, contract/interface violation, missing error handling, silent failure
- **minor** - duplication, naming, small performance, readability with no behaviour change
- **nit** - style, comments, whitespace
- **test-gap** - the only defect is a missing or weak test; no wrong behaviour shown. `why_severity` starts `test-gap - no failing case found`, `test` names the test to write

A finding with a failing case, a repro or wrong-behaviour evidence is never a test gap: rate it by the behaviour and name the test in `test:`.

The validator (`validate`, exit 2) enforces the test-gap rules: refused in a `# Debt` file, the
`why_severity` attestation, and a named `test` (`none` is refused).

## Derived files

- `<slice-id>-r<n>.fixer.md` (`stripForFixer`) - ids, locations, `finding`, `test`; test gaps are
  dropped (a copy with nothing else left reads `CLEAN: nothing to fix`). Severity,
  `why_severity` and `if_unfixed` are removed: the fixer never learns how bad a finding is (D4).
- Blind re-rate copy (`stripSeverity`, `/bajzi:debt --calibrate`) - ids, locations, `finding`,
  `if_unfixed`, `test`, `origin`; severity, `why_severity` and `blind_severity` removed (D7).
- `runtime/findings/debt.md` (`mergeToDebt`) - title `# Debt`, one entry per parked finding with
  id `<origin>/<id>`, the original fields plus `origin: <slice-id>` and `parked: <date>`, and
  `blind_severity:` once calibrated. No header fields. Merging an id already present is a no-op.
  `mergeToDebt` throws on a missing `origin`/`parked`/findings argument or an invalid item, and
  refuses (`DEBT CAP HIT: ...`) a merge whose result would exceed 24 KB; drain first.
- `runtime/findings/needs-owner.md` (`bajzi/lib/findings-cli.js:toOwner`) - the items the owner
  decides, title `# Needs owner`, one appended line each:
  `- <id> · <location> · <rating> · <if_unfixed> · <reason> · your call`, where rating is the
  severity, `<new> (was <old>)` after an escalation, or `original: <x> · blind: <y>` (calibrate).
- `runtime/findings/test-gaps.md` (`bajzi/lib/findings-cli.js:gaps`, `toGaps`) - the missing or weak
  tests, title `# Test gaps`, append-only lines `- <slice>/<id> · <location> · <finding> · <test>`,
  idempotent per `<slice>/<id>`; the owner clears it. Listed in the closing report, never fixed in the run.
- `runtime/slices/<stem>.md` (`findings-cli.js sprint <stem>`) - the sprint's slice file generated from
  the `<stem>-t<N>.md` slices: lowest tier, union of files, joined acceptance, distinct tests.

## Fixer report

The fixer's final message: `FIX <slice> DONE <fixed>/<total>`, then one line per untouched id,
`<id> OUT_OF_SLICE` or `<id> ATTEMPTED: <why>`.

## Close policy after the one re-review (D4, `applyClosePolicy`)

| Round-2 state | Fixer report | Goes to |
|---|---|---|
| `resolved`, any severity | any | closed |
| `open` blocker/major | `OUT_OF_SLICE` | owner, as rated |
| `open` minor/nit | `OUT_OF_SLICE` | `debt.md` |
| `open`, any severity | `ATTEMPTED: <why>` | owner, one level up (blocker stays blocker) |
| `open`, any severity | no line (fixer claimed it fixed) | owner, one level up |
| `open`, new in round 2 | any (ignored) | owner, as rated: the fix introduced it, so it is in-slice |
| round-1 id absent from round 2 | any | owner, at its round-1 severity (unaccounted) |
| `test-gap`, any status | any | `test-gaps.md` (`FC gaps`); never owner, never debt |
| round-1 test gap absent from round 2 | any | nothing (it was never in the fixer copy) |

`applyClosePolicy(round2, fixerReport, round1)` requires the round-1 file of the same slice and
throws without it and returns `{resolved, owner, debt, testGaps}`. `debt.md` only ever receives what the fixer did not attempt (outside the slice).

## Debt cap (D6, `debtCapHit`)

The next sprint does not start when `debt.md` holds more than 15 entries or any single file (the
location without `:line`) holds more than 3. An unparseable `debt.md` counts as a hit.
