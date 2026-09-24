# Plan: bajzi agents + review cadence (L0) — the phase after env-unify

Repo: `bajzi-plugins-dev` (all tasks except T9, which runs on `claude-orchestrator`).
Status: owner-approved decisions baked in (2026-09-23). T0-T7 built on branch `agents-cadence` (whole-branch review r1 fixed); T8 release and T9 acceptance open.
Predecessor: `docs/superpowers/plans/2026-09-23-bajzi-env-unification.md` (must be closed first).
Spec: `bajzi-package-spec.md` — this plan adds §6.12 and rewrites §6.4; §11 gets a row per task.

## 0. How to run this plan

- Read this file top to bottom once. Then work task by task from §5; each task names its files,
  tests, tier, size and acceptance. Do not reorder without a reason written in the HANDOFF.
- **Model policy: L0 only.** Claude subscription, no GLM, no saver routing, no `glm -p`. The day-run
  routing table (haiku/sonnet/opus by task class) applies; the saver levels do not.
- **Cadence for this plan itself** (the rules T5 automates, applied by hand until T5 lands):
  Tier 1 tasks get per-task review; Tier 2/3 tasks get the gate only and one whole-branch review
  before release. Fix rounds are batched: complete findings list → one fix dispatch → one re-review
  → remainder to the owner. No single-finding loops.
- **Dedupe with the env-unify delta:** the delta's "Carried to next plan" items *findings-file
  format + R2/R3 adaptation*, *pre-commit gate*, *semgrep*, *ccusage* are absorbed here (T2, T6, T7;
  semgrep and ccusage deferred, §8). If any of them still sits at the tail of the env-unify plan,
  remove it there first — no task exists in two plans.
- Every task updates the spec in the same commit (§0 of the spec). Anchors are `file:function`,
  never `:line`.

## 1. Goal

Make the review/fix cadence structural instead of prompt discipline, at L0:

1. Four task-class agents shipped by the plugin, with model pins and tool allow-lists Claude Code
   enforces.
2. A findings file format that a non-reader can judge (consequence in plain language) and a
   machine can parse, plus a debt file with a cap and a drain.
3. Skills that orchestrate implement → review → fix → debt, enforcing the two-round cap and the
   close policy, so the orchestrator never hand-writes a review or fix prompt.
4. A dispatch guard that checks `subagent_type`, not prompt regexes.
5. A pre-commit gate that blocks on changed lines and ratchets project-wide counts.
6. Proof: three real application sprints on `claude-orchestrator` at L0 under the new cadence, with
   numbers.

Out of scope (deferred, §8): GLM transport for agent prompts (L1/L2), L3/night run, the pinned
guard set, the OS boundary, semgrep, ccusage, a `locator` agent.

## 2. Entry conditions

All must hold before T1 starts; record them in the HANDOFF as checked:

- env-unify plan closed: bajzi **1.8.0** released (double bump), GSD migration run on the laptop,
  `/bajzi:setup --check` → `clean`.
- The env-unify review delta is applied, including: reviewer **allow-list config** (no model-id
  literal anywhere; one config key read by day-run rules, drain launch, drain verdict); the
  launchers in the repo; the dispatch guard merged into `main` (its current R1–R4 are what T6
  rewrites).
- `project-setup` (`bajzi/skills/project-setup/profile.js`) + the orchestrator's `.claude/project-profile.json` (commit 6af4f98) exist — T7 extends the profile.
- Suites in spec §3 green on `main`.

## 3. Owner decisions (fixed; do not reopen)

| Id | Decision |
|---|---|
| D1 | **Four agents**: `implementer` (sonnet), `implementer-risk` (opus), `reviewer` (opus, read-only), `fixer` (sonnet). No `locator`; mapping is a direct `code-review-graph` call from the main thread. Add `locator` later only if the 40/50 % context guard fires during mapping. |
| D2 | **Orchestration lives in plugin skills** (`/bajzi:implement`, `/bajzi:review`, `/bajzi:fix`, `/bajzi:debt`), so it works in any repo. `run_sprint.py` may call them later; not in this plan. |
| D3 | **Gate = block on changed lines + count ratchet.** ruff/eslint/gitleaks on staged files, blocking; pyright/tsc project-wide, blocking only if the error count rises above the committed baseline. |
| D4 | **Close policy after the one re-review**: open blocker/major → owner; open minor/nit that the fixer *did not attempt* (outside the slice) → `debt.md`; anything the fixer attempted and left unfixed escalates one level and goes to the owner. The fixer fixes every severity in the batch and never sees the severity column. |
| D5 | **Findings carry a consequence.** Mandatory fields `if_unfixed` (what a user/system experiences, plain language) and `why_severity`. The owner judges outcomes, not code. |
| D6 | **Debt cap + drain**: drained by one fixer pass at every milestone review; the next sprint does not start if `debt.md` holds > 15 items or any single file has > 3. |
| D7 | **Blind re-rate during acceptance only**: at the end of each of the three T9 sprints the reviewer re-rates `debt.md` with severities stripped; only disagreements of ≥ 1 level reach the owner, with both ratings and the consequence line. Off after T9. |
| D8 | **Reviewer model**: `model: opus` alias in frontmatter (no version literal); the routing counter verifies the served model against the reviewer allow-list config. |
| D9 | **L0 only** for building and testing everything in this plan. |
| D10 | **Three acceptance sprints** on the claude-orchestrator application backlog; owner names the sprint ids at T9 start. |

## 4. Design

### 4.1 Agents (`bajzi/agents/*.md`, shipped by the plugin)

Common rules — pinned by `bajzi/tests/agents/agents.test.js` (T1):
- Frontmatter: `name`, `description`, `model`, `tools`. `model` is an alias (`sonnet`/`opus`),
  never a versioned id. `tools` is an explicit allow-list.
- Body ≤ 60 lines, contract-shaped: **Input · Output · Rules · Never**. No persona prose.
- No agent may dispatch another agent (`Agent`/`Task` never in `tools`).
- The body is the single source of the role; nothing else restates it.

| Agent | model | tools | Used by |
|---|---|---|---|
| `implementer` | sonnet | Read, Edit, Write, Grep, Glob, Bash | `/bajzi:implement` for Tier 2/3 slices |
| `implementer-risk` | opus | same | `/bajzi:implement` for Tier 1 slices |
| `reviewer` | opus | Read, Grep, Glob, `mcp__code-review-graph__detect_changes_tool`, `mcp__code-review-graph__get_review_context_tool` | `/bajzi:review`, `/bajzi:debt --calibrate` |
| `fixer` | sonnet | Read, Edit, Grep, Glob, Bash | `/bajzi:fix`, `/bajzi:debt --drain` |

Draft bodies (T3/T4 may tighten wording; the contract lines are fixed):

**`implementer.md`**
```
---
name: implementer
description: Implements one specified slice, tests included. Tier 2/3 slices only.
model: sonnet
tools: Read, Edit, Write, Grep, Glob, Bash
---
# Input
A slice spec: id, files it may touch, acceptance criteria, test command.
# Output
1. Code + tests so the acceptance criteria hold and the test command is green.
2. A final message with exactly: `SLICE <id> DONE` or `SLICE <id> BLOCKED: <one line>`,
   then the list of files changed.
# Rules
- Touch only the files listed in the spec. If the slice needs another file, stop and
  report BLOCKED with the file name and why.
- Write the test first when the slice changes behaviour.
- Run the test command before reporting DONE; paste its last 5 lines.
- Keep the diff minimal: no refactors, renames or formatting outside the slice.
# Never
- Never review, rate or summarise your own work beyond the DONE/BLOCKED line.
- Never edit `runtime/**`, `docs/**`, guard files, hooks, settings or `.githooks/**`.
- Never commit, push, stash, rebase or change branches.
```
Amended by the whole-branch review r1 (2026-09-24; not a §3 decision): the slice's `files:` list is
the ownership boundary (`docs/**` included, so Tier-3 docs slices go through the agent), the report
follows `docs/slice-format.md` "Agent report", and `test: none` means no test run. The shipped
`bajzi/agents/implementer.md` is authoritative.

**`implementer-risk.md`** — identical body to `implementer`, plus under Rules:
```
- This slice is Tier 1 (locks, concurrency, quotas, auth, money, migrations, destructive
  scripts, or ≥ 3 files). Add a failing test for every branch you change before changing it.
```
with `model: opus` and `description: Implements one Tier 1 slice.` The test suite asserts the
two bodies differ only in that block (T4).

**`reviewer.md`**
```
---
name: reviewer
description: Reviews a commit range and writes a findings file. Read-only. Never fixes.
model: opus
tools: Read, Grep, Glob, mcp__code-review-graph__detect_changes_tool, mcp__code-review-graph__get_review_context_tool
---
# Input
`range` (base..tip), `slice_id`, `round` (1 or 2), the path to write the findings file to,
and for round 2 the previous findings file.
# Output
The findings file in the format of docs/findings-format.md, nothing else in the file.
Final message: the findings file itself and nothing else (the verdict is its header line).
# Rules
- Call detect_changes_tool for the range first, then get_review_context_tool for each changed
  symbol. Read only files the graph names; do not browse.
- One finding = one defect at one location. Merge duplicates; do not pad.
- Severity by the rubric in the format doc. `if_unfixed` describes what a user or the system
  experiences if this is never fixed, in one plain sentence, no code words. `why_severity`
  names the rubric line.
- Round 2: judge only whether each previous finding is resolved; add new findings only if the
  fix introduced them. Mark each previous id `resolved` or `open`.
- Changed logic without a test is at least major.
# Never
- Never propose or write code; findings describe the defect and the test that would catch it.
- Never rate a finding lower because the fix looks hard.
- Never read the severity column of a previous round when re-rating (calibration mode).
```

**`fixer.md`**
```
---
name: fixer
description: Fixes every finding in a findings file in one pass. Tier-agnostic.
model: sonnet
tools: Read, Edit, Grep, Glob, Bash
---
# Input
A fixer copy of a findings file (`*.fixer.md`: ids, locations, findings, tests — no
severities) and the test command.
# Output
1. Every finding addressed, or per finding a one-line reason it was not touched, using exactly
   one of: `OUT_OF_SLICE` (pre-existing code outside the slice's files) or
   `ATTEMPTED: <why it could not be resolved>`.
2. Test command green. Final message: `FIX <slice> DONE <fixed>/<total>` then one line per
   untouched id.
# Rules
- Treat every finding as equally important; there is no severity in your input by design.
- Fix at the location named; if the real cause is elsewhere in the slice's files, fix it there
  and say so.
- Add the test the finding names before fixing, when one is named.
# Never
- Never widen scope beyond the findings and their tests.
- Never argue with a finding in code comments; use `ATTEMPTED:` in the report.
- Never commit, push, stash, rebase, change branches, or edit guard files/hooks/settings.
```

### 4.2 Findings format (`docs/findings-format.md`, parser `bajzi/lib/findings.js`)

One file per review round: `runtime/findings/<slice-id>-r<round>.md`. Machine-parsed; the parser
rejects a file with a missing mandatory field.

```
# Findings · <slice-id> · round <n>
range: <base>..<tip>
reviewer: opus            # frontmatter alias; served model is verified by the routing counter
verdict: FINDINGS 3       # or CLEAN
files_reviewed: 6

## F1 · blocker · app/billing/retry.py:41
finding: a timed-out payment call is retried without an idempotency key
if_unfixed: a customer whose payment times out can be charged twice
why_severity: wrong behaviour with data/money effect
test: tests/test_retry.py::test_timeout_is_idempotent (to write)
status: open              # round 2 only: resolved | open

## F2 · minor · app/core/needs_you.py:88
finding: retry loop duplicated from retry.py
if_unfixed: two copies drift; a later fix lands in one of them
why_severity: no behaviour change, maintainability
test: none
```

Severity rubric (in the format doc; the reviewer cites its line in `why_severity`):
- **blocker** — wrong behaviour, security, data loss/corruption, money, or changed logic with no test
- **major** — edge-case bug, contract/interface violation, missing error handling, silent failure
- **minor** — duplication, naming, small performance, readability with no behaviour change
- **nit** — style, comments, whitespace

Derived files the skills generate:
- `<slice-id>-r<n>.fixer.md` — same ids/locations/findings/tests, severity and `why_severity`
  stripped (D4).
- `runtime/findings/debt.md` — one entry per parked finding: original fields + `origin: <slice-id>`
  + `parked: <date>`; `blind_severity:` added by `--calibrate`.
- `runtime/findings/needs-owner.md` — appended by `/bajzi:review` round 2 and `/bajzi:debt`: the
  items the owner must decide, each with both ratings (if any) and the `if_unfixed` line.

### 4.3 Skills (`bajzi/skills/{implement,review,fix,debt}/SKILL.md`)

Skills orchestrate; agents execute. Every skill logs one TSV line to
`runtime/dispatch-sizes.log` per dispatch (the existing R4 format).

**`/bajzi:implement <slice-spec>`** — reads `runtime/slices/<id>.md` (`tier:`, `files:`,
`acceptance:`, `test:`); dispatches `implementer-risk` when `tier: 1`, else `implementer`; passes
only the spec; on `BLOCKED` stops and reports. The Tier-1 → opus rule is thereby a lookup, not a
memory.

**`/bajzi:review <slice-id> <range> [--round 2 --previous <file>]`** — dispatches `reviewer`,
receives the findings file as its final message and writes it (the reviewer has no write path, D1); validates the file with `findings.js`; prints verdict and counts by severity.
Round 2 applies the close policy (D4): `open` blocker/major → `needs-owner.md`; `open` minor/nit
that the fixer report marks `OUT_OF_SLICE` → `debt.md`; any `ATTEMPTED` id → escalated one level →
`needs-owner.md`. Then checks the debt cap (D6) and prints `DEBT CAP HIT` if so.

**`/bajzi:fix <findings-file>`** — generates the `.fixer.md`; dispatches `fixer` with it and the
slice's test command; runs the gate; then calls `/bajzi:review --round 2`; **stops**. There is no
round 3 in the skill; the owner starts one by hand if they want it (Invariant 10).

**`/bajzi:debt --check | --drain | --calibrate`** — `--check`: cap test, exit 1 on hit (called by
`/bajzi:implement` before dispatching; a hit refuses to start the slice). `--drain`: builds a fixer
copy of `debt.md`, dispatches `fixer`, runs the gate, dispatches `reviewer` once on the resulting
range, removes resolved entries, prints `drained <n>, remain <m>` + the remaining `if_unfixed`
lines. `--calibrate` (T9 only): builds a severity-stripped copy, dispatches `reviewer` in
calibration mode, writes `blind_severity`, and appends every ≥ 1-level disagreement to
`needs-owner.md` in the form `original: minor · blind: major · <if_unfixed> · your call`.

### 4.4 Dispatch guard rewrite (`bajzi/hooks/dispatch-guard.sh`)

Classification by `subagent_type` first; prompt-text regexes only as a fallback for foreign
agents. Fails open, as before.

- **R1'** — a dispatch whose `subagent_type` is not `reviewer` but whose prompt matches the old
  REVIEW/REREVIEW pattern → deny: "use /bajzi:review". A `reviewer` dispatch must carry a range
  (`[0-9a-f]{7,}\.\.[0-9a-f]{7,}`) → else deny (no write path: the reviewer never writes, D1/§4.3;
  calibrate's range-less brief passes only on its `.blind.md` single-file opt-out — T6).
- **R2'** — a dispatch whose `subagent_type` is not `fixer` but whose prompt names a
  `runtime/findings/*.md` or `*-review.md` file → deny: "use /bajzi:fix". A `fixer` dispatch must
  name exactly one `*.fixer.md` path → else deny. A `reviewer` dispatch is exempt too (amended
  in T6): it is read-only, and calibrate names `runtime/findings/debt.blind.md` and round 2 names
  the round-1 findings and the fixer report on purpose.
- **R3** — the cap in force, 24576 chars, for every dispatch that is not `fixer` (amended in T6:
  the earlier "unchanged 6000" predates the Task-10 interim bump to 24576, and T5's
  `findings-cli.js` `BRIEF_MAX` 24000 would be denied under 6000); `fixer` dispatches are
  exempt (the `.fixer.md` is the input, and the parser caps it at 40 findings / 24 KB).
- **R4** — unchanged logging.
- The old ~24-char write-target heuristic is deleted.

The routing counter gains one check: a `reviewer` dispatch whose served model (from the
transcript, as the spec already does for saver violations) is not in the reviewer allow-list config
→ one violation line `reviewer-model=<served>`.

### 4.5 Gate (`bajzi/gate/pre-commit.js`, installed by `project-setup` into `.githooks/pre-commit`)

Node, no dependencies. Reads the staged file list, then:

| Tool | Scope | Effect |
|---|---|---|
| `gitleaks protect --staged` | staged diff | block on any hit |
| `ruff check <staged .py>` | staged files | block on any error |
| `eslint <staged .js/.jsx/.ts/.tsx>` | staged files | block on any error |
| `pyright` | project-wide | block if error count > `.gate-baseline.json` `pyright` |
| `tsc --noEmit` | project-wide | block if error count > `.gate-baseline.json` `tsc` |

- Tool absent for the repo (no `pyproject.toml` → skip ruff/pyright; no `package.json` → skip
  eslint/tsc) → skipped with one log line, never a block. A tool missing from PATH that the repo
  needs → **block** with the install one-liner (fail-closed: a gate you can't run is not green).
- Ratchet: when a project-wide count *drops*, the hook rewrites `.gate-baseline.json` and stages it
  so the improvement is locked in the same commit. The baseline file is created by
  `pre-commit.js --init` (T7 owner step, once per repo).
- Exit codes: 0 clean, 1 blocked, 2 tool error (also blocks). Only exit codes are read, never
  console text (the RTK lesson from `check.ps1`).
- `.claude/project-profile.json` gains `"gate": {"tools": [...], "baseline": ".gate-baseline.json"}`;
  `project-setup` installs the hook and refuses if `core.hooksPath` is not `.githooks`.

### 4.6 Spec changes

- New **§6.12 Agents, skills and findings** (agents table, contracts, findings format pointer, skills,
  close policy D4–D7, debt cap).
- **§6.4** rewritten to R1'/R2'/R3/R4.
- **§2 change map** rows: agent bodies (Tier 2, test `agents.test.js`), findings format/parser
  (Tier 1 — it decides what reaches the owner), skills (Tier 2), dispatch guard (Tier 1, as now),
  gate (Tier 1).
- **§7.2** rows: `runtime/findings/*.md`, `debt.md`, `needs-owner.md`, `runtime/slices/*.md`,
  `.gate-baseline.json`.
- **§4 Invariants**: add 13 — "Every review runs through the `reviewer` agent and every fix through
  the `fixer` agent; the skills own the two-round cap; the fixer never sees severity."
- **§11**: one row per task with the verify command.

## 5. Tasks

Sizes: S ≤ 2 h, M ≤ half a day, L ≤ a day. Tier per spec §2 semantics.

| Task | Deliverable | Files | Tests | Tier | Size |
|---|---|---|---|---|---|
| **T0** Standing rule "Owner tasks — do it yourself" | Append Appendix A verbatim to `DAY-RUN-RULES.md` (60 lines today; Appendix A is 10 → 70, leaves headroom); first commit of this plan | `bajzi/skills/mode/DAY-RUN-RULES.md` | existing line-count test stays < 80 | 2 | S |
| **T1** Agent scaffold + harness | `bajzi/agents/` dir, plugin manifest entry (Invariant 5), `agents.test.js` (frontmatter shape, alias-only `model`, allow-list `tools`, body ≤ 60 lines, no `Agent`/`Task` tool, required headings Input/Output/Rules/Never) | `bajzi/agents/`, `bajzi/skills/setup/manifest.json`, `bajzi/tests/agents/agents.test.js` | the new suite | 2 | S |
| **T2** Findings format + parser | `docs/findings-format.md` (rubric incl.), `bajzi/lib/findings.js`: `parse`, `validate`, `stripForFixer`, `applyClosePolicy(round2, fixerReport)`, `debtCapHit`, `mergeToDebt`, `stripSeverity` | as named + `bajzi/lib/tests/findings.test.js` | fixtures: valid file, each missing field rejected, close-policy table (every D4 branch), cap at 15 / 3-per-file, 24 KB cap, round-2 `resolved`/`open` | 1 | M |
| **T3** `reviewer` + `fixer` agents | bodies per §4.1 | `bajzi/agents/reviewer.md`, `fixer.md` | T1 harness + a **contract test**: a fixture repo with two planted defects (one blocker with money effect, one nit); dispatch `reviewer` via `claude -p`, assert the file parses, both ids present, blocker ≥ major; dispatch `fixer` on the `.fixer.md`, assert tests green and report format | 1 | M |
| **T4** `implementer` + `implementer-risk` | bodies per §4.1; test asserts the two differ only in the Tier-1 block and `model` | `bajzi/agents/implementer.md`, `implementer-risk.md`, `runtime/slices/` spec format in `docs/slice-format.md` | T1 harness + diff assertion + one contract run on a fixture slice | 2 | S |
| **T5** Skills | `/bajzi:implement`, `/bajzi:review`, `/bajzi:fix`, `/bajzi:debt` per §4.3 | `bajzi/skills/{implement,review,fix,debt}/SKILL.md` + shared `bajzi/skills/lib/dispatch.md` (the dispatch template + TSV log line) | `bash bajzi/skills/mode/tests/mode.sh` gains cases: fix stops after round 2; review round 2 routes each D4 branch to the right file; `--check` exit 1 on cap; `--calibrate` writes only disagreements | 1 | M |
| **T6** Dispatch guard rewrite + routing counter | R1'/R2'/R3/R4 per §4.4; reviewer-model check | `bajzi/hooks/dispatch-guard.sh`, `routing-counter.sh` | `mode.sh` case 13x rewritten: allow/deny per row of §4.4, fail-open on a missing agents dir, `fixer` exempt from R3, old heuristic gone | 1 | M |
| **T7** Gate | `pre-commit.js` per §4.5, `--init`, profile key, project-setup install | `bajzi/gate/pre-commit.js`, `bajzi/gate/tests/pre-commit.test.js`, `bajzi/skills/project-setup/profile.js`, `docs/gate.md` | fixture repos: staged ruff error blocks; count-equal passes; count-up blocks; count-down rewrites baseline and stages it; missing needed tool blocks with install hint; absent stack skipped; gitleaks hit blocks; exit codes only | 1 | M |
| **T8** Spec + release | §4.6 changes; bajzi **1.9.0** (double bump); `/bajzi:setup` on the laptop; `project-setup` on claude-orchestrator (profile gains `gate`, `.gate-baseline.json --init` committed) | spec, plugin/marketplace json, orchestrator `.claude/project-profile.json` | §3 suites green; `/bajzi:setup --check` clean; `/bajzi:project-setup --check` clean; whole-branch review before the bump (Tier 1 items only get per-task review before this) | 1 | S |
| **T9** Acceptance — 3 sprints at L0 | Three real application sprints on `claude-orchestrator` (owner names ids) run entirely through `/bajzi:implement` → `/bajzi:review` → `/bajzi:fix`, `/bajzi:debt --calibrate` at each sprint end, `--drain` after sprint 3 | orchestrator repo; `docs/reviews/2026-xx-acceptance-l0.md` | metrics per sprint from `dispatch-sizes.log` + findings files: dispatches, review rounds, findings by severity, `OUT_OF_SLICE`/`ATTEMPTED` counts, blind-rerate disagreements, gate blocks (true/false), wall time | 3 | 3 sprints (real work, not framework time) |

Rough framework effort: T1–T8 ≈ 2.5–3 days at L0. T9 is the application work you were going to do
anyway, now measured.

## 6. Acceptance criteria — "day-run ready (L0)"

All of these, from the T9 report, or the package is not ready:

- ≤ 2 review rounds in every sprint (the skill makes 3 impossible; check no hand-started round 3).
- Zero R1'/R2' denies in sprint 3 (the orchestrator has stopped hand-dispatching reviews/fixes).
- Every findings file parsed first time in sprint 3 (reviewer contract holds).
- Blind re-rate disagreement ≤ 20 % of debt entries across the three sprints; if higher, the rubric
  is edited and sprint 3 is repeated — not the process.
- Gate: no false block (a block the owner overruled) in sprints 2–3; ≥ 1 true block or a clean run
  with zero baseline regressions.
- Owner statement in the report: "I judged every needs-owner item from `if_unfixed` alone."

## 7. Machine setup steps (Who = me, per Appendix A)

| Step | Who | Rung | How |
|---|---|---|---|
| gitleaks, pyright already on the laptop; ruff if missing | me | 1 | `pip install ruff` in each Python repo's `.venv` via command-runner |
| Same on the VM | me | 1 (ssh) or 2 | over ssh if a tool exists; otherwise `scripts/owner/install-gate-tools.sh`, owner runs one command |
| Manifest entries for the three tools (Invariant 5) | me | — | part of T7 |
| `claude plugin update bajzi@bajzi-plugins` after the 1.9.0 bump | **you** | 2 | the session cannot reinstall the plugin it runs from; one command, printed by T8 |
| `/bajzi:setup`, `/bajzi:project-setup` in claude-orchestrator, `pre-commit.js --init`, commit `.gate-baseline.json` | me | 1 | approval line for the orchestrator commit, then run |

eslint/tsc come with the web `package.json`; nothing to install.

## 8. Carried to the next plan (not started here)

- **GLM transport** for agent bodies (`glm -p --append-system-prompt-file <agent body>`) and the
  L1/L2 acceptance sprints; `implementer` at L2 = GLM with the same body.
- **`locator` agent** (haiku) — only if the context guard fires during mapping in T9.
- **semgrep** as a Tier-1 pre-pass in the gate; **ccusage** cross-check.
- **OS boundary** (devcontainer vs low-privilege user) → **pinned guard set** → **L3 / night run**
  acceptance. Owner decision 2026-09-23 stands: no night run before the pinned set is built and
  review-clean.
- `run_sprint.py` calling the skills (D2, second half).

## 9. HANDOFF for this plan

Lives in **claude-orchestrator** `runtime/handoff/<new-bajzi-branch>.md` (that is where the SessionStart hook loads it from), even though the work happens in bajzi-plugins-dev. Template:

```
Plan: 2026-09-bajzi-agents-and-cadence · at: T<n> · L0
Done: T1..T<n-1> (commits …)
Next exact step: <task · file · test to run>
Decisions/pitfalls: …
Files touched this session: …
```

## Appendix A — text for `bajzi/skills/mode/DAY-RUN-RULES.md` (T0, verbatim, 10 lines)

```
## Owner tasks — do it yourself
Default: if you can do it, you do it. No question, no approval line. A step assigned
to the owner is the exception and must name its rung:
1. Permission-gated (~/.claude, settings, deploy/release, secrets, git history, another
   repo's commit, anything auto-mode still blocks) → STILL your task: one approval
   line, then you run it. Never turn an approval into an owner task.
2. Impossible even with approval (elevation, login, UI, a machine you have no tool on)
   → scripts/owner/<name>.ps1|.sh, idempotent; the owner runs one command.
3. Not scriptable (physical action, wizard, owner-only judgment) → numbered steps.
"Who" in any plan or table is "me" unless rung 2/3; a "you" cell names its rung.
```
