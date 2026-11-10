# Development process
Valid for bajzi 1.39.0.
Sources: `docs/methodology-guide.md`, `docs/slice-format.md`, `docs/findings-format.md`, `docs/gate.md`, the agents, skills and hooks.

## 0. Principles
- **Methodology:** superpowers everywhere. Never ask which methodology to use. A `.claude/METHODOLOGY` file overrides it; when the file is missing, superpowers applies. Do not use gsd-* skills, claude-mem make-plan/do, or `.planning/`.
- **Start with brainstorming, not code.** Superpowers' sizing step decides how much process a task gets:
  - a quick, clear task: done directly;
  - a small change: agreed in chat;
  - a project: gets a written plan.
- TDD wherever there is behaviour to pin down. The review loop runs at every size.
- **When to ask the owner:**
  - ask WHAT before the plan, and one batch of HOW questions after the plan draft;
  - execution starts only when the plan's open-questions list is empty;
  - unattended runs never ask: a genuinely new decision parks that item with the question written down.
- **The owner panel:** in an orchestrator pane, owner questions and owner steps go through the `ask_owner` panel, in Hungarian and in plain words.
  - A reversible decision gets `default_taken` and work continues.
  - Only a risky decision sets `blocking`.
- **Token budget:**
  - never go above 50% context, and start no new scope above 40%;
  - sub-agents do exploration, test runs and multi-file reads;
  - files over ~300 lines never come into the main thread.
- **Language:** everything written and read back is in English (handoff, memory, commits, code comments). Owner-facing Hungarian only where asked.
- **Owner steps:** click-by-click, with exact commands. When there are several, they go in one checklist as an Artifact, or in the panel.

## 1. Sizes (`size` in .claude/project-profile.json; set by /bajzi:project-setup)
| Size | Adds |
|---|---|
| XS | One general local repo, `notes/<topic>/`. No plan or review unless a real system is touched. |
| S (default) | Local git, handoff, tests for every behaviour change, one written plan per feature. |
| M | S + the pre-commit gate, Opus review, `docs/uat/<release>.md`, `docs/DEPLOY.md`. |
| L | M + CI, CHANGELOG, `docs/rollback.md`, a `/bajzi:respec-cards` spec before the plan, `docs/definition-of-done.md`. |

- **How the size is decided:** five start questions, and the highest answer wins.
  - deployed, has other users, holds personal data or money: at least M;
  - has a release cycle, or more than one developer, service or repo: L.
- **Changing the size:** only upward, and only with the owner's OK.
- **GitHub or local:** decided by data sensitivity, separately from size.
  - Personal data, confidential material, credentials or financial data → `local`, and the pre-push hook refuses GitHub remotes.
  - Otherwise `github`, in a private repo.

## 2. Phases, idea to install
1. **Idea:** 3-5 sentences, no code. 
2. **Refine:** `superpowers:brainstorming`, and optionally `bajzi:grilling`. Decisions go into the spec's `## Decisions` section, or into `runtime/handoff/<topic>.md`. L-size work uses `/bajzi:respec-cards`.
3. **Spec:** a design doc, `docs/superpowers/specs/<date>-<topic>-design.md`.
4. **Plan:** `superpowers:writing-plans` writes `docs/superpowers/plans/<date>-<topic>.md`.
   - **Plan critic (M/L):** `/bajzi:critic <stem>` runs the read-only `plan-critic` agent (model: profile key `plan_critic_model`, default fable; a Fable limit falls back to opus, never a stop). It reads the plan, the slices and the code and writes `runtime/critic/<stem>.md`: at most 3 ranked scenarios per slice and 10 per plan (trigger, user-visible break, slice, proving test, confidence). It asks what happens to in-memory state on eviction or rebuild, to browser-only state on chat switch or reload, whether every fetch and model output (including empty output) has a failure path, and which block an event binds to when a new block started meanwhile.
   - The owner sorts the scenarios in the batch of plan questions (`## Triage`: accept or reject). Accepted ones become specific, testable acceptance items. Unattended, high-confidence scenarios are accepted automatically and marked `auto`; a plan can skip the critic with one line `skipped: <reason>`, visible in the ledger.
   - **Enforcement:** `FC slice <stem>-t<N>` and `FC sprint <stem>` exit 5 in an M/L repo without a ready critic file, and a hook covers the superpowers execution skills. S repos and non-plan ids pass.
   - The owner reviews the plan; nobody asks about the execution method.
   - With no mode active, execution is subagent-driven-development plus the bajzi review loop.
5. **Slices:** `runtime/slices/<id>.md`, one per plan task, following docs/slice-format.md. Each slice lists `files:`, acceptance items, a tier and tests. `FC sprint <stem>` writes the sprint file.
6. **Implement:** `/bajzi:implement <id>` runs the implementer agent for the slice's tier, then commits `<id>: implement` and prints the commit range.
7. **Review:** `/bajzi:review` dispatches `bajzi:reviewer` with the full-SHA range, which writes `runtime/findings/<id>-r1.md`. Test gaps go to `test-gaps.md`.
8. **Fix:** `/bajzi:fix`. The fixer works from a severity-blind copy (`<id>-r1.fixer.md`) and writes `<id>-r1.report.md`. The gate runs, the fix is committed, and the round-2 review writes `<id>-r2.md`. The close policy then writes `needs-owner.md` and `debt.md`.
9. **Sprint-end gate:** the full test suite, once per sprint, in the background.
10. **UAT:** done by the owner, for M and up.
11. **Close and deploy:** `superpowers:finishing-a-development-branch`.
    - A person approves the push and the deploy, and the SHA is named first.
    - The install candidate is the last closed, owner-accepted SHA, never HEAD blindly.
- **Unattended multi-slice runs:** the Workflow tool, driven by a `/bajzi` skill. The owner must opt in. Slice ids are full names.
- **Files that carry state:**
  - handoff: `runtime/handoff/<branch-slug>.md`;
  - decision log: `runtime/DECISIONS.md`, committed once per sprint;
  - run reports: `runtime/AUTOPILOT-REPORT.md` and `runtime/DAY-RUN.log`.

## 3. Agents
| Agent | Model / effort | Tools | Role and limits |
|---|---|---|---|
| implementer | Sonnet / medium | Read, Edit, Write, Grep, Glob, Bash | Tier 2/3 slices. Edits only `files:`, test first. Ends with `SLICE <id> DONE` or `BLOCKED`. Never commits, pushes, rebases, self-reviews, or touches `runtime/**`, hooks, settings or `.githooks`. |
| implementer-risk | Sonnet / high | same | Tier 1. Same rules, plus a failing test for every changed branch. |
| fixer | Sonnet / medium (high when risk-bearing) | Read, Edit, Grep, Glob, Bash | Severity-blind copy, all findings treated as equal. Names the invariant a finding breaks and greps for every other path that breaks it; effort high on Tier 1. Reports `FIX DONE n/m`, `OUT_OF_SLICE` / `ATTEMPTED` lines and a mandatory `CAVEAT:` line. Never dispatches agents. |
| reviewer | Opus / high (sprint review at xhigh, round 2 at high; Tier 2/3 reviews at medium) | Read, Grep, Glob, 2 code-review-graph tools | Read-only, no shell. Its final message is the findings file. Never writes code and never rates lower because a fix looks hard. Model allow-list in `~/.claude/bajzi/config.json`. |

The orchestrating session never writes slice code, fixes or reviews itself. Every agent goes through the dispatch brief, log and save steps.

## 4. Tiers
- **Tier 1:** locks, concurrency, quotas, auth, money, migrations, destructive scripts, secrets, outward-facing actions. File count alone does not make a slice Tier 1.
- **Tier 2:** everything else, except docs.
- **Tier 3:** docs only.
- **Implementer choice:** `FC slice` picks the implementer from `tier:` (Tier 1 → implementer-risk). The orchestrator never chooses it.
- **Reviewer:** every review is Opus; effort follows the tier (Tier 1 or unknown xhigh in round 1, high in round 2; Tier 2/3 medium).
- **Monitoring:** if Tier 1 round-1 majors run at about twice the baseline for two sprints in a row, raise it with the owner.
- **Lifecycle line:** each slice names, for every new piece of state, where it lives (DB, process memory, browser) and what happens on restart, eviction, chat or thread switch, a failed or repeated send, a second block in the same thread, and day rollover.

## 5. Review loop
- **Rounds:** at most two per slice. A third round is the owner's call, started by hand.
- **Severities:** blocker, major, minor, nit, test-gap. A finding with a repro is never a test gap.
- **CLEAN:** nothing open but test gaps, plus a green gate.
- **Close policy** (`FC close`):
  - resolved → closed;
  - open blocker/major that is out of the slice → owner;
  - open minor/nit that is out of the slice → `debt.md`;
  - claimed fixed but still open, or ATTEMPTED → owner, one level up;
  - new in round 2 → owner;
  - test gap → `test-gaps.md`.
- **Debt cap:** more than 15 entries, more than 3 in one file, or an unparseable `debt.md` → `FC check` exits 4, and no new slice or sprint starts.
  - `/bajzi:debt --drain` runs one fixer pass and one review.
  - `--calibrate` does a blind re-rate.
- **CAVEAT:** the fixer's `CAVEAT:` line is read before round 2 is paid for. Round 2 runs anyway; the caveat goes to `needs-owner.md` and the owner can stop it. Unattended, the decision and caveat go into the run report and nothing stops the run. A finding that needs a design choice gets a one-line directive from the owner or planner first (unattended: the lowest-risk reversible choice, reported).
- **Owner items:** `runtime/findings/needs-owner.md`, each with `if_unfixed` and "your call".

## 6. Gate
- `.githooks/pre-commit` (bajzi gate) runs on every commit. It is required for M and L.
- It runs gitleaks, ruff and eslint on staged files, and a pyright/tsc ratchet against `.gate-baseline.json`.
- Exit codes: 0 clean, 1 blocked, 2 tool error. Never `--no-verify`.
- The full test suite runs once per sprint. The repo's own gate command is in its CLAUDE.md, for example `uv run pytest -m "not live" -q`.

## 7. Modes and unattended runs
- **Day-run** (`runtime/bajzi-mode` or `~/.claude/bajzi-mode`):
  - The orchestrator keeps design and verdicts.
  - Routing: locate/tests → Haiku, implement → Sonnet, review → the reviewer model.
  - Direct edits are allowed only when all hold: at most 20 lines, one file, no new logic.
  - Only three questions are allowed: scope change, forbidden zone, park-or-continue.
  - Saver levels L0-L3 move work to GLM. Only the owner changes the level.
- **Autopilot:**
  - No questions; the lowest-risk, reversible choice wins, and every choice goes into the decision log.
  - Forbidden zone, which gets BLOCKED and skipped: deploy, force-push, history rewrite, deletions, secrets, `.github/`, live migrations, major dependency bumps, scope change.
  - At most 3 fix attempts, then PARKED.
  - Ends with `runtime/AUTOPILOT-REPORT.md`.
- **Night-run:** preflight → collect → plan → one approval screen → launch on "go" → morning report.
  - `docs/NIGHT-RULES.md` overrides everything.
  - Every item gets two review rounds at most, otherwise PARKED.
  - No overlap with the 06:00-10:00 UTC GLM peak window.

- **Dynamic workflow** (the Workflow tool, needs owner opt-in): a script drives the slices in the background.
  - Per slice, always the same chain: prep → implement → commit → r1 review → fix → r2 → close → gate → push.
  - The script is idempotent and restart-safe:
    - it resumes from the git log (`<id>: implement`, `<id>: fix r1 findings`) and the findings files;
    - it skips closed slices;
    - it stashes a dirty tree before a new slice.
  - A stop (open blocker or major) halts the chain and is reported to the panel.
  - A /clear or exit of the launching session kills the run; relaunch it fresh, since resume works only within the same session. Keep context low while it runs.
  - Slice ids must be full names. Clerk agents run on Sonnet or wf-clerk, to keep cost down.
- **Which automaton to use:**

| | Day-run | Workflow | Night-run |
|---|---|---|---|
| Use when | owner present, decisions expected, few slices | finished plan, many slices, no open questions, owner nearby | many independent, well-specified items, hours unattended |
| Quality | best where decisions are needed | uniform strict chain; stops on decision-type findings | same chain, but nobody decides overnight; undecided items are PARKED |
| Main downside | the main session re-reads its whole context on every message | agent startup is a large share of cost; dies with its session | most setup work; avoid the GLM peak window, 06-10 UTC |

## 8. Hooks (enforced by the harness, not by prompts)
- **SessionStart:**
  - handoff-load: loads the branch handoff and prints its opening prompt;
  - methodology-guard;
  - day-run and saver rules;
  - radar;
  - writer-guard inbox;
  - ask-owner rule when `ORCH_BUS_PANE` is set;
  - status signal.
- **PreToolUse (fails closed):**
  - context-guard: denies everything except the handoff at 50% context;
  - secret-guard: `.env*` and secret patterns;
  - kill-guard: no kills by process name;
  - writer-guard: no edits to installed bajzi copies;
  - saver-guard;
  - file-lock: one session per file;
  - dispatch-guard (Agent, in day-run or saver mode):
    - reviews must use `bajzi:reviewer` with a range and a graph marker;
    - findings files go only to the fixer or the reviewer;
    - briefs over 24 KB are denied;
    - every dispatch is logged.
- **PostToolUse:** a 40% context warning, injection scan, security reminders, read-nudge, routing counter.

## 9. Handoff and context
- Write `/bajzi:handoff` and `/clear` around 40% context. In an orchestrator pane the app runs this itself.
- **The file:** `runtime/handoff/<branch-slug>.md`, untracked, at most ~40 lines, with exactly one opening-prompt code block. No secrets in it.
- **When to rewrite it:** after every slice commit and every verdict, at 40% context, and before any stop.
- **Do not overwrite a peer:** never overwrite another session's handoff that is less than 2 hours old.
- **Topic notes** go in the same folder and are listed in the branch file.

## 10. Rules that cause damage when forgotten
- Run `git fetch` before judging git state. Stage with `git add -- <files>`, never `-A`. Never route state-changing git through rtk.
- A guard deny means stop, without rewording the brief. Exception: a saver-guard deny is rerun on GLM.
- When an `FC` exit code is unnamed, stop.
- bajzi is changed only by the session in the bajzi main checkout. Other sessions send requests and never edit bajzi.
- Fixers may not prove their tests red: mutation-check the new tests yourself. Strip CRs before commits on Windows.

## 11. Measurement
- `FC ledger <stem>` writes one ledger line per sprint; `FC ledger escaped <stem> "<text>"` records a bug found after install; `FC ledger report` prints the read-out.
- **Per slice:** round-1 blocker/major count (lifecycle or other), new majors in round 2+, majors still open after round 2, rounds, and critic scenarios raised, accepted and later matched by a real finding.
- **Per sprint:** tokens and dollar equivalent by phase and model from the transcripts' usage fields (agents exact by type, the main session approximate). Raw rows come first; savings are labelled an estimate and are computed against a baseline named by the machine-level `ledger_baselines` key in `~/.claude/bajzi/config.json` (`savings: n/a` without it).

## 12. Next development
- Review the measurements after 2 weeks; extend the period if there were fewer than 2 M/L sprints.
