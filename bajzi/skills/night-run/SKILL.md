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
    model:opus       Orchestrator model = entry [0] of the reviewer allow-list; omitted =
                     the same. Read it with
                     `node "${CLAUDE_PLUGIN_ROOT}/hooks/node/lib/reviewer-models.js" --first`
                     (`reviewer_models` in `~/.claude/bajzi/config.json`); exit 1 = the list
                     is invalid, a BLOCKER at the PHASE D gate ("run /bajzi:setup"), never a
                     guessed id. It sets ONLY the per-story orchestrator — the review-and-fix
                     loop's reviewer is ALWAYS a model on that allow-list.
    hours:<n>        Queue budget in hours, default 8. It SIZES the queue, and PHASE E's
                     `--deadline` — the hard stop — is DERIVED from it: launch time plus
                     `hours:`, capped at 07:30. They are one number, never two.
    status           Bare mode: read-only health check (below). Changes nothing.
    report           Bare mode: PHASE F, the morning follow-through (spec section 5).

## Review loop — when an item is actually done

Every queue item goes through the review-and-fix loop, and the reviewer is **always the reviewer
allow-list's first entry** (`{{REVIEWER_MODEL}}` in the brief) —
whatever the per-story orchestrator is, and whatever model wrote the code. The reviewer model is
not a variable, and it never drops a tier because a diff looks small.

The loop does not stop after one pass. Findings go to a FIXER sub-agent — never the reviewer that
raised them — and the fix gets a NEW reviewer round. Fix → review → fix → review, until it
comes back clean. A single fix wave is not a loop.

**Clean** means zero Critical AND zero Important findings AND the repo's own gate green. Minor and
cosmetic findings are collected into the morning report for the owner, never looped on — style nits
regenerate forever and would burn the night without making anything safer.

Nothing is reported DONE, and nothing is merged, before that loop terminates clean. "The tests
pass" is not done. "The implementer says it works" is not done. A clean review round plus a green
gate is done; anything short of it is PARKED, with its open findings named.

Watch for tests that pass for the wrong reason. A test asserting only that *something* was refused
stays green after the check it exists to guard is deleted, because the code has several refusal
paths. A reviewer that cannot say WHICH path refused has not verified that test.

## PHASE A — Preflight

Run all of it before planning anything, and run step 0 FIRST — steps 3, 4 and 5, and the
whole of PHASE C, read values out of `config.env`, so it has to exist and be checked before
anything reads it. Exactly two findings STOP the skill on the spot, because nothing past
them is worth planning: a live runner FOR THIS PROJECT (steps 1-2) and a missing
`docs/NIGHT-RULES.md` (step 6). Every other failure is a BLOCKER — carry it and report it at
the PHASE D gate, do not stop.

**`<REPO>` and `<BASE>` are TWO DIFFERENT THINGS and this skill decides both.** `REPO` is
`owner/name` — a GitHub coordinate, the argument `gh` takes after `-R`; `run.sh` refuses at
startup anything without a `/` in it. `BASE` is an absolute FILESYSTEM PATH, the repo
checkout directory the run works from: `run.sh` tests `[ -d "$BASE" ]`, requires
`$BASE/.claude/settings.local.json`, and runs `df` on it. **Never pass `REPO` to `-C`, to
`df`, or as the first half of a path** — `git -C bajzaa975/innotel-bss fetch` dies with
`fatal: cannot change to …: No such file or directory`, and `<REPO>/docs/NIGHT-RULES.md`
opens nothing. Anywhere below that a path is meant, it is spelled `<BASE>`; `<REPO>` appears
only where the `owner/name` value is wanted. There is no third spelling.

0. **`config.env` — resolve and validate it BEFORE anything reads it.** It is the single
   source of `REPO`, `BASE`, `BASE_BRANCH`, `NIGHT_DIR`, `DISK_FLOOR_GB` and the thirteen
   PHASE C placeholders, and `BASE` in particular is the directory the allowlist is
   installed into and every story session starts from — an invented value points the whole
   night at the wrong tree.

   ```bash
   CFG=~/night-runs/<project>/config.env
   [ -f "$CFG" ] && echo "CONFIG PRESENT" || echo "FIRST RUN — no config.env yet"
   ```

   **`CONFIG PRESENT`** → load it and check it before anything uses it:

   ```bash
   set -a; . "$CFG"; set +a
   case "$REPO" in */*) :;; *) echo "BLOCKER: REPO is not owner/name: '$REPO'";; esac
   [ -d "$BASE" ]      || echo "BLOCKER: BASE is not a directory: '$BASE'"
   [ -d "$NIGHT_DIR" ] || echo "BLOCKER: NIGHT_DIR is not a directory: '$NIGHT_DIR'"
   case "$DISK_FLOOR_GB" in ''|*[!0-9]*) echo "BLOCKER: DISK_FLOOR_GB is not a number";; esac
   ```

   Any line of output is a gate BLOCKER — carry it, and never substitute a guess for the
   bad field. `REPO` and `BASE` are the two that must not be confused; see the paragraph
   above.

   Seven more keys are OPTIONAL — absent is fine, every one has a default, and an older
   `config.env` still starts (`templates/config.env.tmpl` carries the same list, commented
   out):

   - `WATCH_INTERVAL` (900) — seconds between watchdog ticks; `0` turns the watchdog off.
   - `WATCH_MAX_RESTARTS` (2) — how many times the watchdog may restart a dead runner.
   - `WATCH_NOTIFY_CMD` (none) — a command called with ONE argument, the message.
   - `QUOTA_MARGIN_SEC` (180) — seconds added to the announced usage-limit reset before a
     session is launched again; `run.sh` applies it once, when it writes `quota-until`.
   - `QUOTA_MAX_WAITS` (3) — how many usage-limit waits ONE run may take before it finishes.
   - `QUOTA_MAX_WAIT_SEC` (21600) — the longest SINGLE usage-limit wait; beyond it the run
     leaves the rows `DEFERRED-quota`, reports and finishes instead of holding the run lock.
   - `QUOTA_FALLBACK_WAIT_SEC` (1800) — the wait used when the reset time cannot be parsed.

   **`FIRST RUN`** → create it here, before step 3, and never later:

   ```bash
   mkdir -p ~/night-runs/<project>/logs
   cp <absolute path of templates/config.env.tmpl> ~/night-runs/<project>/config.env
   ```

   Then fill in every `<...>` with a value you RESOLVED, and say where each came from:
   `REPO` and `BASE_BRANCH` from `gh repo view --json nameWithOwner,defaultBranchRef`;
   `NIGHT_DIR` from the template's own convention; `BASE` from the existing checkout of
   `REPO` on this machine — find it, do not guess it:
   `/usr/bin/git -C "<candidate>" remote get-url origin` must name `REPO`. If NO checkout
   resolves, or MORE THAN ONE does, `BASE` is the one value you may not settle yourself:
   leave it unfilled, carry it as the first line of the PHASE D gate, and plan nothing that
   depends on it. A freshly written `config.env` is a gate item in its own right — show the
   owner the whole file at PHASE D, because everything below was derived from it.

1. **Is a runner already alive FOR THIS PROJECT?** Identify a runner by its ARGV, never by a
   `pgrep` pattern. The spec names `pgrep -af "bash .*/run\.sh( |$)"` as one of three WRONG
   forms: it also matches the shell running the check and the `pgrep` subshell — five pgids
   for one live runner, observed 2026-09-18. A process IS a runner when `argv[1]` (or
   `argv[0]`, when run.sh is executed directly) basenames to `run.sh`; a shell that merely
   mentions run.sh has `argv[1] == "-c"` and is excluded. Scope it to THIS project by
   requiring this project's config path in the same argv — another project's runner must
   never block this project's plan. `is_runner_pid` in `run.sh` is the same ARGV test, but
   only that half: `run.sh`'s `live_runner_pgids` applies NO config scoping, so its own fence
   counts EVERY `run.sh` on the machine. The two answer different questions — never read one
   as a proxy for the other.

   ```bash
   CFG=~/night-runs/<project>/config.env           # THIS project's config, absolute
   pids=$(pgrep -f 'run\.sh'); rc=$?   # NEVER `for p in $(pgrep ...)`: that throws the rc away
   [ "$rc" -le 1 ] || { echo "RUNNER SCAN FAILED (pgrep rc=$rc)"; exit 1; }   # 0=hits 1=none >1=broken
   for p in $pids; do
     [ -r "/proc/$p/cmdline" ] || continue
     argv=$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null) || continue
     a0=$(printf '%s\n' "$argv" | sed -n 1p); a1=$(printf '%s\n' "$argv" | sed -n 2p)
     [ "${a1##*/}" = run.sh ] || [ "${a0##*/}" = run.sh ] || continue
     printf '%s\n' "$argv" | /usr/bin/grep -qxF "$CFG" || continue
     awk '{print $5}' "/proc/$p/stat" 2>/dev/null   # field 5 of stat = pgid
   done | sort -u
   ```

   `RUNNER SCAN FAILED`: the SCAN broke (pgrep missing, denied, rewritten), so the empty
   result means nothing — refuse and report it as a STOP, never read it as "no runner". This
   is `run.sh`'s own rule at `live_runner_pgids`, whose comment records that reading an
   erroring pgrep as "nobody home" has started a second runner in one worktree three times.

   **This test is deliberately narrow and it has a known blind spot — step 2 is what covers
   it, so step 2 is NOT optional.** `grep -qxF "$CFG"` demands the config path as its own
   argv word, which only a `--config <path>` launch produces. `run.sh:91` also accepts
   `CONFIG=${NIGHT_CONFIG:-}`, and `config.env.tmpl` advertises that form: a runner started
   as `NIGHT_CONFIG=… bash ./run.sh` carries NO config path in argv at all and is invisible
   here. PROVEN on this machine 2026-09-18 — the live runner's whole argv was `bash ./run.sh`
   and nothing else. So "no line" means *no runner NAMED this config*, never "no runner";
   only step 2's `run.flock` cross-check can tell those apart, and it must always be run.

   No line, rc 0 or 1: continue TO STEP 2. ONE line: a live run for this project — STOP. TWO OR MORE:
   STOP and report it loudly, that is two runners sharing one worktree. Never a bare `ps | grep`:
   `rtk` rewrites `ps`, the format changes, the pattern silently finds nothing, and on
   2026-09-18 that made a healthy runner look dead.
2. **Cross-check the lock — always, whatever step 1 printed.** `run.flock` is THE lock: the
   runner holds `flock(2)` on it for the whole run, the kernel releases it the instant the
   runner dies, and the file is never unlinked — so there is no such thing as a stale
   `run.flock` and there is never anything to clean up. `run.lock` is a REPORT, not a lock:
   one line carrying the live runner's pgid, for humans and for this check. Ask the kernel,
   never the file:

   ```bash
   ND=~/night-runs/<project>
   exec 9>>"$ND/run.flock"
   if flock -n 9; then flock -u 9; echo "NO RUNNER"; else echo "RUNNER ALIVE (run.lock says pgid $(cat "$ND/run.lock" 2>/dev/null || echo '-'))"; fi
   exec 9>&-
   ```

   **`NO RUNNER`** — nobody holds the lock: continue, and carry NOTHING to the gate. A
   `run.lock` left behind next to a free `run.flock` is stale bookkeeping, not a blocker;
   never delete it yourself. **`RUNNER ALIVE`** — a run for this project is live: STOP. This
   is also exactly the case step 1 cannot see on its own when the runner was started as
   `NIGHT_CONFIG=… bash ./run.sh`.
3. **Git.** Quote the path exactly as written — the allowlist's scoped `-C` rules match the
   raw command text, and a bare or differently quoted path falls through to the classifier:

   ```bash
   /usr/bin/git -C "<BASE>" fetch origin --prune
   /usr/bin/git -C "<BASE>" rev-list --left-right --count <BASE_BRANCH>...origin/<BASE_BRANCH>
   ```

   A non-zero right-hand count (the base branch is behind its remote) is a gate blocker.
4. **Disk.** `df -BG --output=avail "<BASE>" | tail -1` must be at or above `DISK_FLOOR_GB`
   from `config.env` — the build cache has filled this VM's root twice.
5. **Is the base branch red?** The latest `REQUIRED_CHECK` run on the base branch:
   `gh run list -R <REPO> --branch <BASE_BRANCH> --limit 3 --json name,conclusion,event`.
   Red = the top blocker; do not queue filler work around a red base.
6. **`docs/NIGHT-RULES.md` gate.** Missing in the project repo → copy
   `templates/NIGHT-RULES.md.tmpl` there, show the owner that it needs their rulings, STOP.

### `status` mode

The read-only subset of PHASE A: safe while a run is live, creates nothing, launches
nothing. Print and stop — runner alive plus its pgid (step 1); the current story and how
long it has run (`tail ~/night-runs/<project>/logs/runner.log`); this run's
`~/night-runs/<project>/state-<date>.txt` rows so far (`state.txt` is a symlink to that
file, so the old name still works) — an id may have more than one row, and its LAST row is
its outcome; `gh pr list --state open`; free disk.

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

PHASE A step 0 already created the run directory and `config.env`; re-assert the directory
here (`mkdir -p` is idempotent) so this phase still works when step 0's output is out of
sight. NOTHING ELSE creates it. `config.env` says `NIGHT_DIR` "must
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
  **Name mapping, deliberate, do not "correct" either side:** the 4th FIELD of `queue.txt` is
  called `<note>` because that is the name `run.sh` parses it under
  (`IFS='|' read -r id slug needs note`, and its block message calls it "the 4th column"), but
  in the rendered `{{QUEUE_TABLE}}` that same field is the column headed **`criteria`** —
  which is the header the brief's eight "acceptance-criteria cell" / "criteria column"
  references resolve against. `queue.txt` keeps `note`; the markdown header says `criteria`.
- `BRIEF.md`, rendered from `templates/BRIEF.md.tmpl` in three steps, in this order.

  **1. Substitute these THIRTEEN placeholders, and only these thirteen.**
  `{{PROJECT}} {{REPO}} {{BASE}} {{BASE_BRANCH}} {{BRANCH_PREFIX}} {{NIGHT_DIR}} {{MODEL}}
  {{REQUIRED_CHECK}} {{PER_STORY_TIMEOUT}}` come from the same-named `config.env` fields;
  `{{NIGHT_RULES}}` is the full body of the project's `docs/NIGHT-RULES.md`, verbatim;
  `{{RUN_DATE}}` is `date +%F` of the night being planned;
  `{{REVIEWER_MODEL}}` is entry [0] of the reviewer allow-list (the `--first` read above);
  `{{QUEUE_TABLE}}` is the ordered queue as a markdown table whose header row is exactly
  `| id | size | needs | criteria |` —
  **escape every `|` inside a cell as `\|`**. Criteria routinely contain pipes
  (`sort -u | wc -l`, a literal `a|b`), and one unescaped pipe splits the row: the proven
  case rendered SIX cells instead of four, with the criteria cell ending mid-word at
  ``Export must emit `a`` — and a reviewer grading that fragment returns a genuine pass.

  **HOW to substitute — `{{NIGHT_RULES}}` is a whole FILE BODY, not a word.** A
  `sed 's|…|…|'` cannot carry it: the body has NEWLINES (sed's replacement text is one
  line), and a `&` or a `\1` anywhere in the rules re-inserts the match instead of itself —
  `run.sh` carries a `sed_repl` escaper for exactly this class of bug. Render the whole file
  with LITERAL string replacement instead, which has no metacharacters at all:

  ```bash
  python3 - ~/night-runs/<project>/BRIEF.md <BASE>/docs/NIGHT-RULES.md <<'PY'
  import sys
  brief, rules = sys.argv[1], sys.argv[2]
  body = open(rules).read()                   # verbatim: newlines, &, backslashes and all
  src  = open(brief).read()
  assert src.count('{{NIGHT_RULES}}') == 1, 'expected exactly one {{NIGHT_RULES}}'
  src = src.replace('{{NIGHT_RULES}}', body)  # str.replace: BOTH sides literal
  # ... the other twelve single-line values exactly the same way, e.g.
  # src = src.replace('{{PROJECT}}', project)
  open(brief, 'w').write(src)
  PY
  ```

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

  **2. Strip the renderer-only comment block.** The template opens with an HTML
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
  The five runner-owned names are the only exemption. A surviving `{{NIGHT_RULES}}` is
  almost always a BROKEN SUBSTITUTION, not a bad scaffold: `NIGHT-RULES.md.tmpl` spells that
  name WITHOUT its braces on purpose, so a freshly scaffolded project file CANNOT carry the
  token. Re-do step 1 with the literal-replace method above — a `sed` that met the body's
  newlines or an `&` is the usual cause. Check the project's own file only after that, and
  only because an OLD hand-edited one may still carry it:
  `/usr/bin/grep -n '{{NIGHT_RULES}}' <BASE>/docs/NIGHT-RULES.md` — a hit there does
  re-inject a live placeholder, and must be deleted from the project's file.

`config.env` is NOT rendered here — PHASE A step 0 created and validated it, because steps
3-5 and the thirteen placeholders above read it. If it is still missing at this point, step 0
was skipped: go back and do it, do not improvise values. Render only
`settings.local.json`, from `templates/settings.local.json.tmpl`, for PHASE E to install.
The JSON template is NOT copy-ready and its own `_comment_placeholders` says what it needs:

- `<BASE_BRANCH>` and `<BRANCH_PREFIX>` from `config.env`, `<project>` from `PROJECT`, and
  `<NIGHT_DIR>` / `<BASE_DIR>` from `config.env`'s `NIGHT_DIR` and `BASE` — ABSOLUTE, no
  trailing slash, NEVER `~`: a `Bash(...)` rule is matched against the raw command text, so a
  `~` in the rule only ever matches a literal tilde. These two scope the `git -C` allow rules
  to the run's own trees; unscoped, `-C *` reached every git repo on this shared machine.
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
python3 - /home/ubuntu/night-runs/<project>/settings.local.json <<'PY'
import json, re, sys
perms = json.load(open(sys.argv[1]))["permissions"]
rules = perms.get("allow", []) + perms.get("deny", []) + perms.get("ask", [])
bad = [r for r in rules if re.search(r"<[A-Za-z]", r)]
for r in bad:
    print("UNRENDERED RULE:", r)
sys.exit(1 if bad else 0)
PY
echo "rules rc=$?"   # 0 = every allow/deny/ask entry is rendered; anything else = the lines above
```

**The check is scoped to the RULES, never to the whole file, and that is load-bearing.** A
whole-file `grep '<[A-Za-z]'` is UNSATISFIABLE: on a PERFECT render it still returns 6 hits,
every one of them inside the `_comment*` documentation keys, which legitimately spell
`<BASE>`, `<glob>`, `<dir>`, `<stamp>`, `<angle-bracket>`, `<RUN_DATE>`, `<id>`, `<date>`
and `<project>`. Faced with a check that cannot pass, an agent either deletes those comment
blocks — destroying the measured matcher and symlink knowledge the file exists to carry —
or learns to wave the hits through; and the next thing waved through is a REAL leftover
(`Edit(//<absolute path of the deployed tree…>/**)`, the section-3 line, or
`<PR number the run must never merge>`) sitting inside `permissions.deny` matching NOTHING,
with section 3 then unenforced for the whole night. The JSON-scoped check above returns
nothing on that same perfect render and NAMES every leftover on a bad one.

## PHASE D — Approval gate

ONE screen, and it is the ONLY question this skill asks. The run merges to the base branch
for hours while the owner sleeps, so the gate is not optional. Show:

1. the ordered queue — each item with its size and ONE line of why it is in;
2. what the run may merge unattended per the NIGHT-RULES merge policy, plus the reminder
   that **every item passes the Opus review-and-fix loop and must be review-green AND
   CI-green before anything is merged**;
3. what was deferred, and why; 4. every blocker PHASE A found;
5. one line that the PHASE C render gate came back clean: no leftover `{{placeholder}}` in
   `BRIEF.md`, `settings.local.json` is valid JSON, and the rules check over
   `permissions.allow + permissions.deny + permissions.ask` printed no `UNRENDERED RULE:` line (`rules rc=0`).
   Say it in those words. The `_comment*` keys of `settings.local.json` DO still contain
   `<angle-bracket>` text and that is correct — they are documentation, they are not rules,
   and they are outside the check on purpose. If the rules check did not come back 0, you
   are not at this gate yet.
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
pids=$(pgrep -f 'run\.sh'); rc=$?   # 0=hits 1=none >1=the SCAN itself failed
[ "$rc" -le 1 ] || echo "RUNNER SCAN FAILED (pgrep rc=$rc) — this is NOT 'nothing started'"
for p in $pids; do
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
> saw in PHASE A. If it prints `RUNNER SCAN FAILED`, the check broke, NOT the launch: do NOT
> re-run the launch line — that is how a second runner ends up in one worktree. Read
> `tail ~/night-runs/<project>/logs/runner.log` instead, and fix `pgrep` first.
> On a clean ONE-pgid result, `tail ~/night-runs/<project>/logs/runner.log` then shows
> `RUN start` followed by `START <first id>`.
> **Likeliest failure:** the launch line prints
> `bash: .../logs/console.log: No such file or directory` and nothing starts. The `logs/`
> directory is missing, the redirect fails in YOUR shell before run.sh ever runs, and there
> is NO console.log to read — do not go looking for one. Fix:
> `mkdir -p ~/night-runs/<project>/logs`, then re-run the launch line.
> **Second likeliest:** the pgid check prints nothing and `console.log` ends with
> `run.sh: config file not found`. Fix: check the path with
> `ls -l ~/night-runs/<project>/config.env`, then re-run the launch line with the real one.
> **Kill switch, any time:** `touch ~/night-runs/<project>/STOP`, checked between stories.

**The watchdog starts itself.** `run.sh` spawns `night-watch.sh` (next to it) detached as soon
as it holds the run lock — the owner launches nothing extra. It is pure bash and costs ZERO
model tokens, on purpose: a Claude-based watcher would spend the very quota it is there to
watch. Every `WATCH_INTERVAL` seconds (900 by default; `WATCH_INTERVAL="0"` in `config.env`
turns it off) it appends one status line to `~/night-runs/<project>/watch.log` — runner alive
or dead, heartbeat age, free disk, quota wait, queue progress — restarts a dead runner up to
`WATCH_MAX_RESTARTS` times from `run.args`, and creates `STOP` if free disk falls under
`DISK_FLOOR_GB`. It never deletes anything and never signals a story process. The night's
directory is PERMANENT, so it DATES every marker against `run.meta`'s `started_epoch`: a
`finished` or `watch.restarts` left by an earlier night is logged once and ignored
(otherwise the second night's watcher would read yesterday's `finished` seconds after
starting and leave the runner unwatched). `STOP` is dated more generously — against the
EARLIER of `started_epoch` and the watcher's own start — because a restart rewrites
`started_epoch` and a `STOP` you dropped seconds before it is still tonight's. The restart
BUDGET is counted in the watcher's memory, which outlives every runner it restarts;
`watch.restarts` is only a crash hint, read once at start. A run it cannot date — no
`run.meta`, no usable `started_epoch` — is reported `UNKNOWN` and nothing is restarted.

## PHASE F — Morning follow-through (`report` mode)

Per spec section 5: read `~/night-runs/<project>/REPORT-<date>.md` and this run's
`~/night-runs/<project>/state-<date>.txt`.

**Resolve `<date>` first — do not guess it and never glob `state-*.txt`.** The report runs
the morning AFTER `RUN_DATE`, so `state-$(date +%F).txt` is yesterday's name and does not
exist; and `state-*.txt` also matches `state-before-<date>.txt`, the real `state.txt` an
OLDER runner left behind, which is NOT tonight's run. Take the symlink, and fall back to the
newest `state-2*.txt` (that glob cannot match `state-before-…`):

```bash
ND=~/night-runs/<project>
tgt=$(readlink "$ND/state.txt" 2>/dev/null)          # empty when it is not a symlink
STATE=""
[ -n "$tgt" ] && [ -f "$ND/${tgt##*/}" ] && STATE="$ND/${tgt##*/}"   # a DANGLING link is not a state file
[ -n "$STATE" ] || STATE=$(ls -1t "$ND"/state-2*.txt 2>/dev/null | head -1)
REPORT=$(ls -1t "$ND"/REPORT-2*.md 2>/dev/null | head -1)
RUN_DATE=${STATE##*/state-}; RUN_DATE=${RUN_DATE%.txt}
echo "state=$STATE report=$REPORT run_date=$RUN_DATE"
```

Empty `STATE` means no run wrote rows: say exactly that in the report and read nothing else
as a substitute. The `[ -f ... ]` test is what makes that branch reachable — a DANGLING
`state.txt` (the run was cleaned up under it) still gives `readlink` a non-empty name, and
without the test `STATE` would name a file that does not exist, the "no rows" branch would
be skipped, and the morning report would quietly read nothing. A `STATE` whose name contains `before` means the fallback was mis-typed —
stop and resolve it by hand. Then: review every still-open PR with
ONE Opus sub-agent each in the spec's verdict format, never in the main thread; merge only
PRs that are BOTH review-green and CI-green under the NIGHT-RULES merge policy — a PR the
night PARKED is re-reviewed, not waved through because it is morning; run the post-merge
invariants after each merge; clean up worktrees per spec section 8, KEEPING anything dirty,
unpushed or parked; refresh the deck and update the owner's single runbook list in place.

**Read `~/night-runs/<project>/watch.log` before the rows.** One line per watcher tick; what
matters is the STATUS TRANSITIONS — `QUOTA-WAIT`, `RESTARTED`, `DEAD`, `STALLED`, `DISK-LOW`,
`FINISHED`/`STOPPED`/`EXPIRED`, plus any `orphan sid=` lines. `UNKNOWN` means the watcher
itself went blind — no `flock`, a broken `pgrep`, or a `run.meta` it could not read or date —
so THAT TICK restarted nothing. `UNKNOWN` is a per-tick verdict, not a latch: the next tick
that can read `run.meta` is back to normal watching, so treat each `UNKNOWN` stretch — not
everything after it — as unsupervised time and check the runner's own logs across it. A night whose state rows stop
mid-queue is explained there, not in `state-<date>.txt`, and every transition belongs in the
morning report.

**Reading the rows.** A row is `<id> <rc|TOKEN> <ISO time> [reason]`. One id can have
SEVERAL rows — a `DEFERRED-needs` row from pass one plus a terminal row from pass two — and
**the LAST row for an id is its outcome**; the earlier rows are its history. Every id in the
file belongs in the report, none may be dropped. A numeric second field is a story that ran,
and the number is its exit code. Every other second field is a runner-side outcome:

- `BLOCKED-queue` — malformed queue line (bad id charset, missing or invalid slug). Fix the
  line before re-queueing it.
- `BLOCKED-criteria` — the queue line carried no acceptance criteria, so the story was never
  launched. Write real criteria into the line, then re-queue.
- `BLOCKED-needs` — the `needs` column held no PR number. A configuration error: fix the
  column.
- `BLOCKED-needs-unknown` — `gh` failed, so the runner could NOT tell whether the dependency
  PR merged. This is NOT "not merged": check the PR yourself, fix the `gh` auth, re-queue.
- `BLOCKED-brief` — the per-story brief could not be rendered, so the story never started.
  A render bug: no code was written, fix the render and re-queue.
- `BLOCKED-deadline` — no time left before the hard deadline. Re-queue it at the front of
  tomorrow's queue.
- `DEFERRED-needs` — the dependency PR was not merged in time. Non-terminal: if no later row
  for that id follows, the story never ran tonight and goes back into the queue unchanged.
- `DEFERRED-quota` — the model's usage limit cut that session short; the reason column
  carries `resets=<ISO-8601 UTC>`. NON-TERMINAL: the runner waits and re-picks the story in
  a later pass, so if a terminal row for that id follows, it ran. If none follows, it never
  ran tonight and goes back into the queue unchanged.
- `DEFERRED-quota-weekly` — the same, but the WEEKLY limit. Also non-terminal, and no night
  can wait it out: do NOT re-run before the weekly reset named in the reason column.
- `DEFERRED-alive` — the story was skipped this pass because its PREVIOUS session was still
  alive (reason `sid=<sid>`); non-terminal, so a later pass or the next night picks it up.
- `INTERRUPTED` — the runner was signalled and that story was killed mid-flight. Its worktree
  may be dirty or half-pushed, so keep it, inspect it, and re-queue the story.

**Reading the report.** `REPORT-<date>.md` is written in two layers. `run.sh` writes the
facts itself, with no model involved, so they exist even when the night ended on a usage
limit or a crash: `## Counts`, `## Stories` (one row per id, its LAST row), `## Quota` (the
`DEFERRED-quota*` lines and the moment launches were allowed again) and `## Runner facts`.
`## Narrative` is appended afterwards by one Claude session, and it is **absent when the
limit was still in force** — an absent narrative is not a failed report, it is the limit.
Finally, `~/night-runs/<project>/finished` (one epoch) is written as the LAST act of a real
QUEUE run, after the report — and DELETED again when the next queue run takes the night, so
it always belongs to the newest run that started. (A `--report` or `--smoke` run writes no
`finished` at all: it is not the night.) No `finished` file means the run did not end on its
own, so read `watch.log` for what happened to it. Check its CONTENTS, not just its presence
— an epoch older than this run's `started_epoch` is a marker the runner never cleared (the
watcher ignores it for exactly that reason).

**Token usage.** If `~/.claude/worker-mode` is `glm` and `worker` is on PATH, run
`worker --usage $RUN_DATE` and add its last two lines to the morning report under a
"Token usage (GLM vs Anthropic)" heading; skip silently if the command is missing.

## Closing report

Table: what was queued (id · size · why) · what was deferred and why · PHASE A blockers ·
the paths of the generated files (`config.env`, `queue.txt`, `BRIEF.md`,
`settings.local.json`) · whether `<BASE>/.claude/settings.local.json` already exists, so the
owner knows PHASE E will back it up rather than eat it. State plainly that nothing was
launched and that the run starts only when the owner runs PHASE E.
