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
- `verdict`: `CLEAN` when no finding is open, else `FINDINGS <n>`, where `n` is the number of
  findings in round 1 and the number of `open` findings in round 2.
- Finding heading: `## <id> · <severity> · <path[:line]>`. Ids are unique within the file.
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

- **blocker** - wrong behaviour, security, data loss/corruption, money, or changed logic with no test
- **major** - edge-case bug, contract/interface violation, missing error handling, silent failure
- **minor** - duplication, naming, small performance, readability with no behaviour change
- **nit** - style, comments, whitespace

Changed logic without a test is at least major.

## Derived files

- `<slice-id>-r<n>.fixer.md` (`stripForFixer`) - ids, locations, `finding`, `test`. Severity,
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

`applyClosePolicy(round2, fixerReport, round1)` requires the round-1 file of the same slice and
throws without it. `debt.md` only ever receives what the fixer did not attempt (outside the slice).

## Debt cap (D6, `debtCapHit`)

The next sprint does not start when `debt.md` holds more than 15 entries or any single file (the
location without `:line`) holds more than 3. An unparseable `debt.md` counts as a hit.
