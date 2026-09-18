# night-run tests

Plain bash. No framework, no fixtures to install, nothing to clean up by hand.
Every check prints one `PASS …` / `FAIL …` line and each script exits 0 only if
every check passed.

```bash
cd bajzi/skills/night-run
bash tests/lock-race.sh        # ~90 s   (40 race trials; `bash tests/lock-race.sh 8` for a quick pass)
bash tests/quota.sh            # ~95 s
bash tests/watch.sh            # ~35 s   (night-watch.sh only: no run.sh, no claude)
```

All three scripts are safe to run on a machine that has a real night running:

* they never execute the real `claude` — every session is a **fake claude**
  script created by `lib.sh`, driven by a plan file;
* everything they create lives under `$NR_SCRATCH` — ONE convention for all
  four files, default `${TMPDIR:-/tmp}/night-run-tests`, override it with
  `NR_SCRATCH=/some/dir`. `watch.sh` does not source `lib.sh` (it needs no fake
  claude and no git base) but uses the same variable and the same default;
* the only processes they ever signal are ones they started themselves, found
  through the session ids the runner recorded under `<night_dir>/story/`;
* each script ends by proving no process is left behind whose command line
  mentions the scratch path.

Point them at another copy of the runner with `NR_SKILL_DIR=/path/to/skill`.
That is how the "before" numbers below were measured.

## What each file is

| file | what it is |
|---|---|
| `lib.sh` | fixtures, sourced by both tests: a git-initialised `BASE` with `.claude/settings.local.json`, a `NIGHT_DIR` with `queue.txt` + `BRIEF.md`, a `config.env` the runner accepts, the fake claude, and the stray-process sweep |
| `lock-race.sh` | the run lock and per-story session liveness |
| `quota.sh` | what happens when the model says "You've hit your session limit" |
| `watch.sh` | `night-watch.sh` alone: its statuses, its marker dating, its restart budget, its single-instance guard and its mode gate. Standalone — it sources nothing, fakes `run.sh` with stubs that record their argv (one of them also behaving like the real runner at queue start), and shadows `update-monitor` with a stub on `PATH` |

### The fake claude

One line of `<night_dir>/fake/plan` per invocation (the last line repeats once
the plan runs out):

| plan line | what the fake does |
|---|---|
| `ok[:secs]` | sleep, print a `RESULT …` line, exit 0 |
| `limit[:secs]` | print the verbatim `You've hit your session limit · resets <h:mm><am/pm> (UTC)` with the reset `secs` ahead, exit 1 |
| `weekly[:secs]` | the same for the weekly limit |
| `hang[:secs]` | sleep, exit 0 — a session that outlives its wrapper |
| `orphan[:secs]` | exit 0 but leave a member behind in the story's session |
| `raw:<text>` | print `<text>` and exit 1 — used to pin an exact reset time and zone |
| `past:<min>` | the session-limit message with a reset `<min>` minutes in the **past**, minute-truncated like the real one |
| `limitnoise[:n]` | the session-limit message followed by `n` (default 20) more output lines, exit 1 |
| `limitok` | the session-limit message, then exit 0 — rc 0 is never a quota row |

The reset time is rounded UP to the next whole minute, because the real message
carries no seconds and a truncated one would land in the past.

Every invocation also appends its own fd table to `fake/fds.log`. That is how
the tests prove fd 9 — the run lock — never reaches a session.

## What `lock-race.sh` proves

1. **(i) 40 two-runner races.** Two runners start within milliseconds of each
   other against ONE night dir that already holds a **stale `run.lock`** (a
   pgid that no longer exists). Exactly one may launch the story; the other
   must exit 3. — *before: 29/40 (11 trials admitted both runners, 8 of them
   ran the story twice in one worktree); after: 40/40.*
2. **(ii) a SIGKILLed runner leaves the lock free.** No trap runs, so nothing
   cleans up — and nothing has to: `flock` lives in the kernel. A new runner
   takes it in ~160 ms, and `run.flock` is still there, because it is never
   unlinked. This check is what caught the `sleep` child that inherited fd 9
   and kept a dead runner's lock alive.
3. **(iv) the story's session, not a wrapper pid.** `pgrep -s <the recorded
   sid>` lists the story's members while it runs; `wait` still returns each
   story's real exit code; a story that left a member behind is drained after
   the wait; and a story whose recorded session is STILL ALIVE is skipped
   rather than started a second time — leaving a **non-terminal
   `DEFERRED-alive sid=<sid>` row**, because nothing is ever dropped silently.
4. **(v) fd 9 in the retry loop.** A **decoy** process whose argv names
   `run.sh` and carries the same `--config` keeps the real runner spinning in
   the post-acquire retry loop while it already holds the lock. Every `sleep`
   the runner forks there is inspected: none may carry fd 9, or a SIGKILLed
   runner would leave the project locked by a sleeping child.
5. **(vi) the night files the queue run owns.** A queue run deletes yesterday's
   `finished` and `watch.restarts` when it takes the night and writes
   `finished` only at the end; a pre-placed `STOP` is the owner's and survives;
   and `--report` leaves `run.args`, `run.meta` and `finished` untouched, so a
   watcher polling a queue run that died is never told the night was a report
   run that already finished.
6. **(vii) `--date` pins the night.** A queue run APPENDS `--date <its own
   date>` to `run.args` when the owner gave none, so a watcher re-exec that
   crosses local midnight stays on the same night; a run started with
   `--date <yesterday>` reads `state-<yesterday>.txt`, SKIPs the rows already in
   it (no merged story is run twice) and reports as `REPORT-<yesterday>.md`; the
   pin is never appended twice; and an invalid `--date` — `2026-02-30`,
   `last night` — is refused with exit 2 before the run does anything.
7. **(iii) no fd leak.** Across every session the whole suite launched, not one
   fd table contains fd 9.

## What `watch.sh` proves

Most scenarios build a throwaway `NIGHT_DIR` under `$NR_SCRATCH`, run
`night-watch.sh --once` and read the single status line; the last three start a
real watcher with `--interval 2` and then stop it.

1. **healthy / stalled.** A real `flock` holder stands in for the runner: fresh
   heartbeat is `OK runner=alive`, a 300 s old one is `STALLED` (the watcher's
   `HEARTBEAT_STALL_SEC` is 180 s = three missed 60 s beats).
2. **restart, then DEAD.** With no lock holder the runner is dead, so the
   watcher re-execs `run.args` **verbatim** — `run.args` is the complete argv,
   argv[0] first, and the stub must therefore receive exactly
   `--config <cfg> --deadline 04:30`, never its own path as `$1`. Three
   SEPARATE `--once` processes: the first restarts and leaves the crash hint
   `watch.restarts=1`, the second resumes the count FROM that hint
   (`RESTART 2/2`, and it says so), the third is `DEAD`. Exactly two stub
   calls, never a third.
3. **quota.** `quota-until` in the future is `QUOTA-WAIT` and no restart.
   60 s PAST it, with `QUOTA_MARGIN_SEC="600"` in the config, is `quota=none`:
   `run.sh` already added the margin before writing the file, so the watcher
   adds nothing.
4. **disk floor.** An impossible `DISK_FLOOR_GB` gives `DISK-LOW` and creates
   `STOP` with the reason on its first line. Nothing is ever deleted.
5. **finished.** A `finished` marker gives `FINISHED` and exit 0.
6. **notify.** Two identical ticks notify once; a status change notifies again.
7. **mode gate.** `run.meta` with `mode=report` makes the watcher log and exit 0
   before its first tick. Belt and braces: only a queue run publishes `run.meta`
   at all, so this is for a hand-started watcher and for an older runner's
   leftovers.
8. **a SECOND night in the same directory.** `NIGHT_DIR` is permanent, so
   yesterday's `finished`, `STOP` and `watch.restarts` are still in it: each is
   logged once and treated as absent, the dead runner is restarted `1/2`, and
   `watch.restarts` is overwritten with `1`. Tonight's own `finished` and `STOP`
   (mtime now) still end the watch with `FINISHED` / `STOPPED`.
9. **an undatable run fails closed.** No `run.meta`, or a `started_epoch` that
   is not an epoch (an ISO string), is `UNKNOWN` and restarts nothing.
10. **`DEFERRED-*` is never counted done.** A `DEFERRED-alive` row leaves
    `queue=1/2 deferred=1`; the counting is prefix based, so a new token needs
    no change here.
11. **single-instance guard + TERM.** A process merely NAMED `night-watch.sh`
    that watches another run does not block a new watcher (the guard checks the
    argv basename AND the config/night dir); a real second watcher on the same
    config declines with exit 0; and a `TERM` stops the watcher within a second,
    because each sleep slice is a child it `wait`s on, and removes `watch.pid`.
12. **the restart budget survives the runner it restarts.** A LIVE watcher
    against a stub that behaves like the real `run.sh` at queue start — it
    deletes `watch.restarts` and republishes `run.meta` with a fresh
    `started_epoch` — still restarts exactly `WATCH_MAX_RESTARTS=2` times and
    then says `DEAD`. The budget is the watcher's own in-memory count; the file
    is only a crash hint for the next process.
13. **a `STOP` dropped just before a RESTART still stops the run.** It is older
    than the restarted runner's `started_epoch` but newer than the watcher's own
    start, so it is tonight's: `STOPPED`, exit 0, and never logged as stale.
    (`lock-race.sh` (vi) proves the runner's half — a pre-placed `STOP` survives
    the start of the run and stops the night before the first story.)
14. **teardown.** No process is left under the scratch tree.

## What `quota.sh` proves

*Before this work run (A) burned its four-story queue in **one second** — which
is exactly what happened in production on 2026-09-18; the file scored 6 of the
33 checks it had then. It is 73/73 now.*

* **(A) a session limit mid-queue.** Story 2's limit becomes a **non-terminal**
  `DEFERRED-quota` row whose reason is the parsed `resets=<ISO-8601 UTC>`;
  stories 3 and 4 are not launched until the wait is over; after the wait
  stories 2, 3 and 4 all complete; the report exists with a `## Quota` section
  and `finished` is written.
* **(B) a weekly limit.** No wait is even attempted — the run finishes in
  seconds, the rows stay `DEFERRED-quota-weekly`, the next story is never
  launched, and the deterministic report is still written.
* **(C) the narrative report session hits the limit.** `REPORT-<date>.md`
  still exists with its counts and its per-story rows, because the
  deterministic part is written BEFORE any model is involved. No second wait.
* **(D) `resets 11:05pm (Europe/Budapest)`.** Parsed to the exact epoch via
  `date -d 'TZ="…" …'`, and with a `--deadline` three minutes out the runner
  refuses the wait, says the deadline was why, and still reports.
* **(E1) a reset one minute in the past.** The message is minute-truncated, so
  a reset announced at 11:02 and read at 11:03 is the SAME reset: the runner
  waits `QUOTA_MARGIN_SEC`, not a day. (Measured before the fix:
  `QUOTA-WAIT until <tomorrow> (1442 min)`, holding `run.flock` for a day.)
* **(E2) a reset twenty minutes in the past + a small `QUOTA_MAX_WAIT_SEC`.**
  That one really is tomorrow's, and a wait that long is refused: the run
  finishes in seconds, the rows stay `DEFERRED-quota`, and the deterministic
  report lists the story the walk never reached as **`not reached`**.
* **(E3) the same reset with a large cap** resolves to the next occurrence of
  that time — a full day out — and the `--deadline` is what bars the wait.
* **(F) the message is not always the last line.** A limit message followed by
  20 more output lines is still classified `DEFERRED-quota` (the classifier
  reads the last 40 non-empty lines, not 8), and the same message with exit
  code 0 is never a quota row.
* **(G) a zone whose local day has already rolled over.** `date -d 'TZ="…" <t>'`
  resolves a bare time against the current day OF THAT ZONE, so a reset the zone
  announced minutes before ITS midnight came out almost a day ahead
  (`resets 11:56pm (Etc/GMT+12)` → **+1414 min** in production). The candidate is
  now computed for yesterday, today and tomorrow in the announcing zone and the
  earliest one inside `QUOTA_PAST_GRACE_SEC` wins, so the same message resolves
  to minutes ago and is treated as NOW. The fixture's zone is a POSIX offset
  spec rather than an IANA name because real zones only exist at `:00`, `:30`
  and `:45` offsets — for a quarter of every hour no IANA name is inside its own
  first 15 minutes, and this case must reproduce at any wall-clock time.
  A plain `(UTC)` reset three hours ahead is unaffected.
* **(H) the report never waits.** The walk ends for its OWN reason (here the
  owner's `STOP`) while `quota-until` is armed an hour out, with
  `QUOTA_MAX_WAIT_SEC` at its 6 h default. The run ends in a second — narrative
  skipped with the reset named in the log, deterministic report on disk with no
  `## Narrative`, `finished` written and `run.flock` free — instead of sitting on
  the project's lock for an hour with nothing running.
* **(I) the kill switch during a wait.** `STOP` dropped in the middle of a quota
  wait is seen in ~3 s (the slice is 5 s, not 60 s), the wait is aborted, and the
  run still reports and writes `finished`.
