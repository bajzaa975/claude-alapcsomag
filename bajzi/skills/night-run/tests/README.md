# night-run tests

Plain bash. No framework, no fixtures to install, nothing to clean up by hand.
Every check prints one `PASS …` / `FAIL …` line and each script exits 0 only if
every check passed.

```bash
cd bajzi/skills/night-run
bash tests/lock-race.sh        # ~60 s   (40 race trials; `bash tests/lock-race.sh 8` for a quick pass)
bash tests/quota.sh            # ~55 s
bash tests/watch.sh            # ~5 s    (night-watch.sh only: no run.sh, no claude)
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
| `watch.sh` | `night-watch.sh` alone: its statuses, its restart budget and its mode gate. Standalone — it sources nothing, fakes `run.sh` with a stub that only records its argv, and shadows `update-monitor` with a stub on `PATH` |

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
   rather than started a second time — with no state row written for the skip.
4. **(iii) no fd leak.** Across every session the whole suite launched, not one
   fd table contains fd 9.

## What `watch.sh` proves

Each scenario builds a throwaway `NIGHT_DIR` under `$NR_SCRATCH`, runs
`night-watch.sh --once` and reads the single status line.

1. **healthy / stalled.** A real `flock` holder stands in for the runner: fresh
   heartbeat is `OK runner=alive`, a 300 s old one is `STALLED` (the watcher's
   `HEARTBEAT_STALL_SEC` is 180 s = three missed 60 s beats).
2. **restart, then DEAD.** With no lock holder the runner is dead, so the
   watcher re-execs `run.args` **verbatim** — `run.args` is the complete argv,
   argv[0] first, and the stub must therefore receive exactly
   `--config <cfg> --deadline 04:30`, never its own path as `$1`. Two restarts,
   then `DEAD`: exactly two stub calls, never a third.
3. **quota.** `quota-until` in the future is `QUOTA-WAIT` and no restart.
   60 s PAST it, with `QUOTA_MARGIN_SEC="600"` in the config, is `quota=none`:
   `run.sh` already added the margin before writing the file, so the watcher
   adds nothing.
4. **disk floor.** An impossible `DISK_FLOOR_GB` gives `DISK-LOW` and creates
   `STOP` with the reason on its first line. Nothing is ever deleted.
5. **finished.** A `finished` marker gives `FINISHED` and exit 0.
6. **notify.** Two identical ticks notify once; a status change notifies again.
7. **mode gate.** `run.meta` with `mode=report` makes the watcher log and exit 0
   before its first tick — a `--report` or `--smoke` run is never restarted.
8. **teardown.** No process is left under the scratch tree.

## What `quota.sh` proves

*Before this work the whole file scored 6/33 and run (A) burned its four-story
queue in **one second** — which is exactly what happened in production on
2026-09-18. After: 33/33.*

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
