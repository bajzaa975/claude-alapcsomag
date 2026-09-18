---
name: night-run
description: Plan an unattended multi-hour overnight autopilot run for one project — preflight, queue, rendered brief, approval gate, and the copy-pasteable launch block the owner runs at bedtime. Use it when the user says "night run", "/bajzi:night-run", "overnight autopilot", "plan tonight's run", "run the backlog overnight", "éjszakai futás", "night run terv".
---

# Night run — you plan it, the owner launches it

The full design is in `docs/superpowers/specs/2026-09-18-night-run-design.md` of this
plugin repo. READ IT when a detail here is not enough: this file is the procedure, the spec
is the reasoning, and where they disagree the spec wins. You never start the runner (PHASE
E) and you never edit `run.sh` or the templates per project — everything project-specific
goes into generated files under `~/night-runs/<project>/`.

## Arguments

    project:<name>   REQUIRED. A project the Brain knows. Verify with `brain next <name>`;
                     if it does not resolve, STOP and list the projects the Brain does know.
    model:opus       Orchestrator model = `claude-opus-5`; omitted = `claude-fable-5-1`.
                     Use it when the Fable budget is spent. It sets ONLY the per-story
                     orchestrator — the review-and-fix loop's reviewer is ALWAYS Opus 5.
    hours:<n>        Queue budget in hours, default 8. It SIZES the queue; the runner's
                     `--deadline` is the hard stop.
    status           Bare mode: read-only health check (below). Changes nothing.
    report           Bare mode: PHASE F, the morning follow-through (spec section 5).

## PHASE A — Preflight

Run all of it before planning anything; every failure is reported at the PHASE D gate.

1. **Is a runner already alive?** One runner = ONE distinct pgid; the parent and its
   subshell are two processes in one group, so compare pgids, never process counts.

   ```bash
   pgrep -af "bash .*/run\.sh( |$)"
   for p in $(pgrep -f "bash .*/run\.sh( |$)"); do awk '{print $5}' /proc/$p/stat; done | sort -u
   ```

   The anchor is load-bearing: the spec's `"bash .*/run\.sh$"` is the argument-less form,
   and because our runner carries `--config ...` the anchor moves behind the arguments as
   `( |$)`. UNANCHORED, the pattern also matches the shell running the check and reports
   phantom runners — three pgids for one live runner, observed. Never a bare `ps | grep`:
   `rtk` rewrites `ps`, the format changes, the pattern silently finds nothing, and on
   2026-09-18 that made a healthy runner look dead. Any pgid line for this project: STOP.
2. **Cross-check the lock.** `cat ~/night-runs/<project>/run.lock` — a pgid that appears in
   the loop above means a live run. STOP.
3. **Git.** `/usr/bin/git -C <REPO> fetch origin --prune`, then confirm the base branch is
   not behind its remote — a non-zero right-hand count is a gate blocker:
   `/usr/bin/git -C <REPO> rev-list --left-right --count <BASE_BRANCH>...origin/<BASE_BRANCH>`
4. **Disk.** `df -BG --output=avail <BASE> | tail -1` must be at or above `DISK_FLOOR_GB`
   from `config.env` — the build cache has filled this VM's root twice.
5. **Is the base branch red?** The latest `REQUIRED_CHECK` run on the base branch:
   `gh run list -R <owner/repo> --branch <BASE_BRANCH> --limit 3 --json name,conclusion,event`.
   Red = the top blocker; do not queue filler work around a red base.
6. **`docs/NIGHT-RULES.md` gate.** Missing in the project repo → copy
   `templates/NIGHT-RULES.md.tmpl` there, show the owner that it needs their rulings, STOP.

### `status` mode

The read-only subset of PHASE A: safe while a run is live, creates nothing, launches
nothing. Print and stop — runner alive plus its pgid (step 1); the current story and how
long it has run (`tail ~/night-runs/<project>/logs/runner.log`); the `state.txt` rows so
far; `gh pr list --state open`; free disk.

## PHASE B — Collect

Sources, in precedence order:

1. `brain next <project> --sessions 5` — the primary well: id, branch, title, status, last touched.
2. `docs/BACKLOG.md` — size S/M/L, coding %, testing state, `depends-on`. Sizing and
   dependency data only; it adds no item the Brain does not know.
3. `gh pr list --state open` — PRs left open by earlier runs, as FOLLOW-UP items, never new stories.
4. The previous `~/night-runs/<project>/REPORT-<date>.md` — its PARKED and BLOCKED entries,
   each with the reason that parked it, as retry candidates.

Then SUBTRACT everything `docs/NIGHT-RULES.md` forbids: forbidden story ids, anything
touching a forbidden path, anything the migration policy reserves for daylight.
**TODO/FIXME mining and lint debt are NOT a source** — they map to no milestone and burn a
story slot a real backlog item needed. Do not scan for them.

## PHASE C — Plan

- **Dependency order.** Respect `depends-on`; a story whose dependency is unmerged is
  skipped FORWARD, never reordered upwards.
- **File-disjoint neighbours**, so consecutive stories do not fight over the same files.
- **Budget.** `S = 1 h · M = 2 h · L = 3 h · unsized = M` — observed session cost, not ideal
  effort. Queue until `hours:` is spent; `PER_STORY_TIMEOUT` stays the hard per-story cap.
- **Deferred items are listed WITH their reason** (budget, dependency, forbidden by the
  rules). Never drop an item silently.

Then write into `~/night-runs/<project>/`:

- `queue.txt`, one line per story in exactly the format the runner parses (`#` starts a
  comment): `<id>|<slug>|<needs>|<note>`.
  `<slug>`: lowercase, hyphenated, <= 5 words (it becomes `feat/<BRANCH_PREFIX>-<id>-<slug>`).
  `<needs>`: `-` for none, otherwise the NUMBER of a PR that must be MERGED first.
  `<note>`: the acceptance criteria, one line — the reviewer is given this verbatim.
- `BRIEF.md`, rendered from `templates/BRIEF.md.tmpl` by substituting EVERY placeholder —
  an unsubstituted `{{...}}` makes the story session refuse to start:
  `{{PROJECT}} {{REPO}} {{BASE}} {{BASE_BRANCH}} {{BRANCH_PREFIX}} {{NIGHT_DIR}} {{MODEL}}
  {{REQUIRED_CHECK}} {{PER_STORY_TIMEOUT}}` come from the same-named `config.env` fields;
  `{{NIGHT_RULES}}` is the full body of the project's `docs/NIGHT-RULES.md`, verbatim;
  `{{QUEUE_TABLE}}` is the ordered queue as a markdown table (id, size, needs, note);
  `{{RUN_DATE}}` is `date +%F` of the night being planned.

Also render `config.env` from `templates/config.env.tmpl` if it is not there yet, and
`settings.local.json` from `templates/settings.local.json.tmpl`, for PHASE E to install.

## PHASE D — Approval gate

ONE screen, and it is the ONLY question this skill asks. The run merges to the base branch
for hours while the owner sleeps, so the gate is not optional. Show:

1. the ordered queue — each item with its size and ONE line of why it is in;
2. what the run may merge unattended per the NIGHT-RULES merge policy, plus the reminder
   that **every item passes the Opus review-and-fix loop and must be review-green AND
   CI-green before anything is merged**;
3. what was deferred, and why; 4. every blocker PHASE A found.
The owner approves or edits once. Then go to PHASE E.

## PHASE E — Launch (the owner's step)

You never launch the runner: a Claude session is denied by the auto-mode classifier
(Interfere With Workloads). Emit the block below with EVERY `<...>` already filled in from
`config.env` and from the absolute path of `run.sh` next to this file — never ask the owner
for a value you can resolve, say where you took it from instead.

> **Where:** this VM, a plain **bash** terminal — not the Claude prompt, not `!`.
> **Working directory:** `<BASE>` (the `BASE` field of `config.env`)

```bash
cd <BASE>
mkdir -p <BASE>/.claude
cp ~/night-runs/<project>/settings.local.json <BASE>/.claude/settings.local.json
setsid nohup bash <absolute path of run.sh> --config ~/night-runs/<project>/config.env --deadline "07:30" >> ~/night-runs/<project>/logs/console.log 2>&1 &
pgrep -af "bash .*/run\.sh( |$)"
for p in $(pgrep -f "bash .*/run\.sh( |$)"); do awk '{print $5}' /proc/$p/stat; done | sort -u
```

`setsid` is required, not cosmetic: `nohup` blocks SIGHUP but not the harness killing the
launching session's process group, so a `nohup`-only runner dies with the session.

> **Success:** the last command prints exactly ONE number, and
> `tail ~/night-runs/<project>/logs/runner.log` shows `RUN start` then `START <first id>`.
> **Likeliest failure:** nothing is printed and `console.log` ends with
> `run.sh: config file not found`. Fix: check the path with
> `ls -l ~/night-runs/<project>/config.env`, then re-run the launch line with the real one.
> **Kill switch, any time:** `touch ~/night-runs/<project>/STOP`, checked between stories.

## PHASE F — Morning follow-through (`report` mode)

Per spec section 5: read `REPORT-<date>.md` and `state.txt`; review every still-open PR with
ONE Opus sub-agent each in the spec's verdict format, never in the main thread; merge only
PRs that are BOTH review-green and CI-green under the NIGHT-RULES merge policy — a PR the
night PARKED is re-reviewed, not waved through because it is morning; run the post-merge
invariants after each merge; clean up worktrees per spec section 8, KEEPING anything dirty,
unpushed or parked; refresh the deck and update the owner's single runbook list in place.

## Closing report

Table: what was queued (id · size · why) · what was deferred and why · PHASE A blockers ·
the paths of the generated files (`config.env`, `queue.txt`, `BRIEF.md`,
`settings.local.json`). State plainly that nothing was launched and that the run starts only
when the owner runs PHASE E.
