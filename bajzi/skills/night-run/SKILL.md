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
    hours:<n>        Queue budget in hours, default 8. It SIZES the queue, and PHASE E's
                     `--deadline` — the hard stop — is DERIVED from it: launch time plus
                     `hours:`, capped at 07:30. They are one number, never two.
    status           Bare mode: read-only health check (below). Changes nothing.
    report           Bare mode: PHASE F, the morning follow-through (spec section 5).

## PHASE A — Preflight

Run all of it before planning anything. Exactly two findings STOP the skill on the spot,
because nothing past them is worth planning: a live runner FOR THIS PROJECT (steps 1-2) and
a missing `docs/NIGHT-RULES.md` (step 6). Every other failure is a BLOCKER — carry it and
report it at the PHASE D gate, do not stop.

1. **Is a runner already alive FOR THIS PROJECT?** Identify a runner by its ARGV, never by a
   `pgrep` pattern. The spec names `pgrep -af "bash .*/run\.sh( |$)"` as one of three WRONG
   forms: it also matches the shell running the check and the `pgrep` subshell — five pgids
   for one live runner, observed 2026-09-18. A process IS a runner when `argv[1]` (or
   `argv[0]`, when run.sh is executed directly) basenames to `run.sh`; a shell that merely
   mentions run.sh has `argv[1] == "-c"` and is excluded. Scope it to THIS project by
   requiring this project's config path in the same argv — another project's runner must
   never block this project's plan. `is_runner_pid` in `run.sh` is the same test.

   ```bash
   CFG=~/night-runs/<project>/config.env           # THIS project's config, absolute
   for p in $(pgrep -f 'run\.sh'); do
     [ -r "/proc/$p/cmdline" ] || continue
     argv=$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null) || continue
     a0=$(printf '%s\n' "$argv" | sed -n 1p); a1=$(printf '%s\n' "$argv" | sed -n 2p)
     [ "${a1##*/}" = run.sh ] || [ "${a0##*/}" = run.sh ] || continue
     printf '%s\n' "$argv" | /usr/bin/grep -qxF "$CFG" || continue
     awk '{print $5}' "/proc/$p/stat" 2>/dev/null   # field 5 of stat = pgid
   done | sort -u
   ```

   No line: continue. ONE line: a live run for this project — STOP. TWO OR MORE: STOP and
   report it loudly, that is two runners sharing one worktree. Never a bare `ps | grep`:
   `rtk` rewrites `ps`, the format changes, the pattern silently finds nothing, and on
   2026-09-18 that made a healthy runner look dead.
2. **Cross-check the lock.** `cat ~/night-runs/<project>/run.lock` — it holds one pgid. If
   that pgid is in step 1's output, a run is live: STOP. If it is not, test the group leader
   WITHOUT signalling anything: `ls -d /proc/<pgid>` — the runner is started with `setsid`,
   so its pgid is also its pid. A directory means it is alive: STOP. "No such file" means a
   stale lock: report it at the gate, and never delete it yourself.
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

First create the run directory — nothing else does. `config.env` says `NIGHT_DIR` "must
already exist", and PHASE E's launch line opens `logs/console.log` in the OWNER'S shell,
before run.sh's own `mkdir -p` can run, so a missing `logs/` kills the night before it
starts and leaves no console.log to diagnose it from:

```bash
mkdir -p ~/night-runs/<project>/logs
```

Then write into `~/night-runs/<project>/`:

- `queue.txt`, one line per story in exactly the format the runner parses (`#` starts a
  comment): `<id>|<slug>|<needs>|<note>`.
  `<slug>`: lowercase, hyphenated, <= 5 words (it becomes `feat/<BRANCH_PREFIX>-<id>-<slug>`).
  `<needs>`: `-` for none, otherwise the NUMBER of a PR that must be MERGED first.
  `<note>`: the acceptance criteria, one line — the reviewer is given this verbatim, so it
  may NEVER be empty and never `-` (that is the needs column's "none" value, not this
  one's; run.sh rejects such a line at parse time as `BLOCKED-criteria` and the story never
  runs). Pipes inside the note are fine here — `IFS='|' read -r id slug needs note` lets the
  note absorb every remaining pipe intact; they are a problem only in the table below.
- `BRIEF.md`, rendered from `templates/BRIEF.md.tmpl` in three steps, in this order.

  **1. Substitute these TWELVE placeholders, and only these twelve.**
  `{{PROJECT}} {{REPO}} {{BASE}} {{BASE_BRANCH}} {{BRANCH_PREFIX}} {{NIGHT_DIR}} {{MODEL}}
  {{REQUIRED_CHECK}} {{PER_STORY_TIMEOUT}}` come from the same-named `config.env` fields;
  `{{NIGHT_RULES}}` is the full body of the project's `docs/NIGHT-RULES.md`, verbatim;
  `{{RUN_DATE}}` is `date +%F` of the night being planned;
  `{{QUEUE_TABLE}}` is the ordered queue as a markdown table (id, size, needs, note) —
  **escape every `|` inside a cell as `\|`**. Criteria routinely contain pipes
  (`sort -u | wc -l`, a literal `a|b`), and one unescaped pipe splits the row: the proven
  case rendered SIX cells instead of four, with the criteria cell ending mid-word at
  ``Export must emit `a`` — and a reviewer grading that fragment returns a genuine pass.

  **These FIVE are RUNNER-OWNED: DO NOT SUBSTITUTE THEM, and never invent values.**
  `{{STORY_DEADLINE_EPOCH}} {{STORY_FINALIZE_EPOCH}} {{CI_WAIT_MINUTES}} {{GIT_USER_NAME}}
  {{GIT_USER_EMAIL}}`. run.sh substitutes all five per story, with literal values, into
  `$NIGHT_DIR/BRIEF-<id>.md`. They are per-story or per-run facts you cannot know: a
  hardcoded `STORY_DEADLINE_EPOCH` gives every story of the night the SAME already-past
  deadline, so each one believes it is out of time on its first compare. `GIT_USER_NAME`
  and `GIT_USER_EMAIL` are real `config.env` fields — that is exactly the trap; they are
  still the runner's to render. `CI_WAIT_MINUTES` likewise comes from `config.env`
  (default 45) and from nowhere else: the runner never reads `docs/NIGHT-RULES.md`, so a
  CI-wait number written there is silently ignored.

  **2. Strip the renderer-only comment block.** The template opens with a ~43-line HTML
  comment addressed to you, which tells the reader "THE SKILL STRIPS THIS ENTIRE COMMENT AT
  RENDER TIME" — a sentence that is false unless you actually do it, at the top of a file
  the session is ordered to obey literally. The block starts on line 1 and ends on its own
  `-->` line; `1,/re/d` stops at the FIRST match, so this is non-greedy by construction:

  ```bash
  head -1 ~/night-runs/<project>/BRIEF.md            # must print exactly: <!--
  sed -i '1,/^-->[[:space:]]*$/d' ~/night-runs/<project>/BRIEF.md
  head -3 ~/night-runs/<project>/BRIEF.md            # must now start with "# <project> night run"
  ```

  If `head -1` is not `<!--`, the template changed: STOP and report it, do not improvise a
  different strip.

  **3. GATE on leftover placeholders — this check lives HERE and nowhere else.** The story
  session must not do it (a session cannot tell a render bug from its own instructions, and
  a self-check it can satisfy by quitting ends every night in 30 seconds), and run.sh only
  makes it fatal for its own per-story render. Nothing is launched until this prints
  nothing:

  ```bash
  /usr/bin/grep -o '{{[A-Za-z_0-9]\+}}' ~/night-runs/<project>/BRIEF.md | sort -u \
    | /usr/bin/grep -vx '{{\(STORY_DEADLINE_EPOCH\|STORY_FINALIZE_EPOCH\|CI_WAIT_MINUTES\|GIT_USER_NAME\|GIT_USER_EMAIL\)}}'
  ```

  Match by TOKEN (`grep -o`), never by line: a line that carries a real leftover next to a
  runner-owned one would be filtered away whole. The character class includes digits on
  purpose. To locate a token the gate printed: `/usr/bin/grep -n '{{NAME}}' .../BRIEF.md`.

  Any line of output is a RENDER BUG: fix it and re-render. Do not proceed to PHASE D, do
  not hand the file to the owner, and never "explain" a leftover token in the gate summary.
  The five runner-owned names are the only exemption. If `{{NIGHT_RULES}}` survives, the
  project's `docs/NIGHT-RULES.md` still carries that token inside its own scaffold comment —
  delete that token from the project's file, it re-injects a live placeholder.

Also render `config.env` from `templates/config.env.tmpl` if it is not there yet, and
`settings.local.json` from `templates/settings.local.json.tmpl`, for PHASE E to install.
The JSON template is NOT copy-ready and its own `_comment_placeholders` says what it needs:

- `<BASE_BRANCH>` and `<BRANCH_PREFIX>` from `config.env`, `<project>` from `PROJECT`.
- ONE `Edit(<glob>)` deny line per forbidden path in `docs/NIGHT-RULES.md` section 3, and
  one `Read(<glob>)` deny line per secret file. This translation is section 3's ONLY
  enforcement channel — sections 1, 5 and 6 are wired into the brief, section 3 is prose
  until you turn it into rules.
- The deployed-tree lines: the real path, or delete them. In a file rule a single leading
  `/` is resolved relative to `<BASE>` and therefore matches NOTHING; write `~/...` for
  home paths and a DOUBLED `//...` for anything else.
- `<PR number the run must never merge>` from NIGHT-RULES section 1, or delete the line.

Then prove the render, with the `~` expanded:

```bash
python3 -c "import json;json.load(open('/home/ubuntu/night-runs/<project>/settings.local.json'))" && echo JSON_OK
/usr/bin/grep -n '<[A-Za-z]' /home/ubuntu/night-runs/<project>/settings.local.json   # must print nothing
```

## PHASE D — Approval gate

ONE screen, and it is the ONLY question this skill asks. The run merges to the base branch
for hours while the owner sleeps, so the gate is not optional. Show:

1. the ordered queue — each item with its size and ONE line of why it is in;
2. what the run may merge unattended per the NIGHT-RULES merge policy, plus the reminder
   that **every item passes the Opus review-and-fix loop and must be review-green AND
   CI-green before anything is merged**;
3. what was deferred, and why; 4. every blocker PHASE A found;
5. one line that the PHASE C render gate came back clean (no leftover placeholder, JSON
   valid, no `<angle-bracket>` left in `settings.local.json`) — if it did not, you are not
   at this gate yet.
The owner approves or edits once. Then go to PHASE E.

## PHASE E — Launch (the owner's step)

You never launch the runner: a Claude session is denied by the auto-mode classifier
(Interfere With Workloads). Emit the block below with EVERY `<...>` already filled in from
`config.env` and from the absolute path of `run.sh` next to this file — never ask the owner
for a value you can resolve, say where you took it from instead.

> **Where:** this VM, a plain **bash** terminal — not the Claude prompt, not `!`.
> **Working directory:** `<BASE>` (the `BASE` field of `config.env`)

**Step 1 — install the allowlist, without destroying anything.** `<BASE>` is a real,
persistent worktree and may already have project settings: a plain `cp` replaces them
silently, and the "just delete the file to revert" promise is then a lie. Back up first.

```bash
cd <BASE>
mkdir -p <BASE>/.claude ~/night-runs/<project>/logs
DEST=<BASE>/.claude/settings.local.json
if [ -e "$DEST" ] && ! cp -a "$DEST" "$DEST.pre-night-$(date +%F-%H%M%S)"; then
  echo "BACKUP FAILED — stopping, nothing was overwritten"
else
  cp ~/night-runs/<project>/settings.local.json "$DEST"
fi
ls -l <BASE>/.claude/
```

> **Success:** `ls` lists `settings.local.json`, plus a `settings.local.json.pre-night-<stamp>`
> if you had one before — that backup is what you move back in the morning, instead of just
> deleting the file. If you see `BACKUP FAILED`, STOP: nothing was overwritten and nothing
> should be launched.

**Step 2 — start the runner.**

```bash
cd <BASE>
setsid nohup bash <absolute path of run.sh> --config ~/night-runs/<project>/config.env --deadline "<HH:MM>" >> ~/night-runs/<project>/logs/console.log 2>&1 &
CFG=~/night-runs/<project>/config.env
for p in $(pgrep -f 'run\.sh'); do
  [ -r "/proc/$p/cmdline" ] || continue
  argv=$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null) || continue
  a0=$(printf '%s\n' "$argv" | sed -n 1p); a1=$(printf '%s\n' "$argv" | sed -n 2p)
  [ "${a1##*/}" = run.sh ] || [ "${a0##*/}" = run.sh ] || continue
  printf '%s\n' "$argv" | /usr/bin/grep -qxF "$CFG" || continue
  awk '{print $5}' "/proc/$p/stat" 2>/dev/null
done | sort -u
```

`setsid` is required, not cosmetic: `nohup` blocks SIGHUP but not the harness killing the
launching session's process group, so a `nohup`-only runner dies with the session. The check
is the argv test from PHASE A, scoped to this project — a plain `pgrep -af` pattern would
count the checking shell itself and print four or five numbers for one runner.

Fill `<HH:MM>` yourself before you show the block: it is the launch time plus the `hours:`
budget you actually queued, and never later than 07:30. Say the arithmetic out loud in the
block ("queued 5.5 h, launching ~23:00 → `--deadline 04:30`"). `--deadline` is the HARD stop;
if `hours:` would run past it, queue less and say so at the PHASE D gate — a 02:00 launch
with `hours:8` puts eight hours of work into a 5.5-hour window and the rest is simply parked.

> **Success:** the last command prints exactly ONE pgid, and it is a NEW number, not one you
> saw in PHASE A. `tail ~/night-runs/<project>/logs/runner.log` then shows `RUN start`
> followed by `START <first id>`.
> **Likeliest failure:** the launch line prints
> `bash: .../logs/console.log: No such file or directory` and nothing starts. The `logs/`
> directory is missing, the redirect fails in YOUR shell before run.sh ever runs, and there
> is NO console.log to read — do not go looking for one. Fix:
> `mkdir -p ~/night-runs/<project>/logs`, then re-run the launch line.
> **Second likeliest:** the pgid check prints nothing and `console.log` ends with
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
`settings.local.json`) · whether `<BASE>/.claude/settings.local.json` already exists, so the
owner knows PHASE E will back it up rather than eat it. State plainly that nothing was
launched and that the run starts only when the owner runs PHASE E.
