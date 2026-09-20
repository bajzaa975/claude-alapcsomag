# Story W1 — night-run runner for native Windows (PowerShell 7)

Date: 2026-09-20 · Owner decision: the laptop is Windows 11 and stays that way; no WSL, no Ubuntu.
Built and tested ON THE LAPTOP by the "Windows-nightrun" Claude session; reviewed by a fresh sub-agent
there; delivered as a PR to `bajzaa975/claude-alapcsomag` `main`. Coordinated with the VM session
`brain_night_run` over cross-session messages (the owner does not relay).

## 1. Goal

`/bajzi:night-run` must work end-to-end on native Windows 11 for a Python project under
`D:\AI\projektek\ClaudeCode\...`, driven by the SAME skill, brief, queue and config the bash runner
uses on the VM. A night on the laptop must produce the same files, the same state-file rows, the
same `REPORT-<date>.md` layout and the same exit codes as a night on the VM, so the planning/status
part of the skill, the morning sweep and the Brain harvester need no Windows branch of their own.

Non-goals: WSL, Cygwin, MSYS `flock` ports, running the bash runner under Git Bash, macOS, a GUI.

## 2. Deliverables (all under `bajzi/skills/night-run/`)

| File | What |
|---|---|
| `windows/run.ps1` | The runner. Functional parity with `run.sh` per §4 and Appendix A. |
| `windows/night-watch.ps1` | The zero-token watchdog. Parity with `night-watch.sh` (Appendix A §6). |
| `windows/worktree-cleanup.ps1` | Parity with `worktree-cleanup.sh` (Appendix A §8). |
| `windows/lib/*.ps1` (optional) | Shared helpers (config parsing, state file, quota parsing, report). |
| `templates/config.env.tmpl` | UNCHANGED format. The PowerShell runner parses the existing `KEY="value"` file. Only addition: a comment saying paths on Windows use forward slashes (`D:/AI/...`). |
| `templates/settings.local.json.tmpl` | UNCHANGED unless a rule provably fails on Windows paths; any change must keep the VM rendering byte-identical (test it). |
| `SKILL.md` | OS detection: on Windows, PHASE E prints the PowerShell launch line (§5) instead of the `setsid nohup bash run.sh` line; the status checks in PHASE A/F use the PowerShell equivalents (§4.9). Everything else unchanged. |
| `tests/windows/*.Tests.ps1` | Pester 5 tests (§6). Run with `Invoke-Pester -Path tests/windows -CI`. |
| `docs/night-run-windows.md` | Owner-facing: prerequisites, the launch line, how to stop a run (`STOP` file), where the logs are, known differences (§4.10). |

Version bump to 1.5.16 is the OWNER's step after merge, not part of the PR.

## 3. Prerequisites the runner may assume (and must verify at startup, exit 2 with a named reason otherwise)

PowerShell 7 (`pwsh`, not Windows PowerShell 5.1), `git` on PATH (Git for Windows), `gh` on PATH and
authenticated, `claude` on PATH (the npm shim `claude.cmd` or `claude.exe` — resolve with
`Get-Command claude` and launch the resolved path), Python 3.12+ only if the project needs it (the
runner itself does not). No admin rights. No Developer Mode (so: no symlinks — see §4.10).

## 4. Design — how each Linux primitive maps

1. **Single-runner lock (`run.flock`).** Open the file with
   `[System.IO.File]::Open(path, OpenOrCreate, ReadWrite, [FileShare]::None)` and hold the handle for
   the runner's whole life; never delete the file. The OS releases the handle when the process
   dies, so there is no stale lock to judge. A second runner whose open throws → exit 3. The watcher
   probes liveness the same way (open with `FileShare.None` → success means DEAD, failure means
   ALIVE, any other exception means UNKNOWN, fail closed). `run.lock` stays a human-readable text
   file containing the runner PID (atomic write via temp file + `Move-Item -Force`).
2. **Per-story session isolation (`setsid` + `timeout`).** Launch `claude` with `Start-Process`
   (`-PassThru`, `-NoNewWindow`, `-WorkingDirectory $BASE`, stdin from `NUL`, stdout+stderr
   redirected to `logs/<id>.log`) and assign the process to a **Windows Job Object** created with
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the whole process tree (claude, its shells, git, gh) is
   killed when the runner closes the job. The job handle is the Windows "session id"; `story/<id>.sid`
   holds the root PID. Budget enforcement: `Wait-Process -Timeout <budget>`; on timeout terminate
   the job, record rc `124`; if the tree is still alive 60 s later record `137`. Liveness:
   `Get-Process -Id` + `HasExited` (Windows has no zombies). `pgrep -s` equivalent: enumerate
   `Win32_Process` by `ParentProcessId` transitively from the root PID, or query the job object's
   process list.
3. **Heartbeat.** `(Get-Item heartbeat).LastWriteTimeUtc = [DateTime]::UtcNow` at least once per 60 s
   in every wait loop (liveness poll, quota wait, watcher sleep slices).
4. **`state.txt` → newest state file.** No symlink. `state.txt` is a plain file rewritten (atomic
   temp + move) to the full content of `state-<RUN_DATE>.txt` after every appended row. Readers
   (skill, watcher, Brain) see identical content. Document this in §4.10.
5. **Read-only brief.** `BRIEF-<id>.md` gets `IsReadOnly = $true` (equivalent of `chmod 0444`).
6. **Disk floor.** `[System.IO.DriveInfo]::new(path).AvailableFreeSpace` for both `BASE` and
   `NIGHT_DIR`; the minimum vs `DISK_FLOOR_GB`; any exception counts as below floor.
7. **Quota / session-limit detection and the bounded wait.** Same grammar, same defaults, same
   rules as Appendix A §4 (last 40 non-blank log lines, `hit your .*limit`, weekly → no wait,
   `resets H:MM[am|pm] (zone)` parsed with `.NET TimeZoneInfo` — accept IANA names via
   `TimeZoneInfo.FindSystemTimeZoneById` which understands IANA on .NET 6+; fallback
   `QUOTA_FALLBACK_WAIT_SEC`; margin, max waits, 6-hour cap, deadline guard, STOP checked every ≤5 s).
8. **Detached watcher.** `Start-Process pwsh -ArgumentList '-NoProfile','-File',night-watch.ps1,...
   -WindowStyle Hidden` after the lock is held. Restart re-executes the exact argv saved in `run.args`
   (one argument per line, argv[0] = the script path), never re-derived. Restart budget lives in the
   watcher's memory, max `WATCH_MAX_RESTARTS`, skipped within 10 min of the deadline. Markers are
   dated against `run.meta`'s `started_epoch` exactly as on Linux.
9. **Runner identity for the skill's PHASE A/F checks.** Enumerate `Win32_Process` where
   `CommandLine` contains `run.ps1` AND the same `--config` path; never a bare process count, never
   the checking shell itself, never "same job". An enumeration that throws → `RUNNER SCAN FAILED`.
   The skill's expected stdout lines (Appendix A §9) are printed verbatim.
10. **Documented differences (allowed, must be listed in `docs/night-run-windows.md`).** `state.txt`
    is a copy not a symlink; PIDs replace pgids in `run.meta`/`run.lock` (`pgid=` key name kept for
    parser compatibility, value is the PID); signal exit codes 130/143 are produced on Ctrl+C /
    `STOP` respectively by the runner itself; `update-monitor note` and `WATCH_NOTIFY_CMD` are
    optional no-ops when absent; `df` semantics replaced by DriveInfo; `chmod` by IsReadOnly.
11. **`claude -p` invocation.** Same flags (`-p "<prompt>" --permission-mode <PERM_MODE> --model
    <MODEL> --output-format text`), same prompt text as `run.sh` builds (copy it; do not reword —
    the RESULT grammar and the epoch statements are load-bearing), same env vars
    (`STORY_DEADLINE_EPOCH`, `STORY_FINALIZE_EPOCH`, `CI_WAIT_MINUTES`, `GIT_*`), `CLAUDECODE`
    removed from the child environment. Pass the prompt as ONE argument via `-ArgumentList` array,
    never via string concatenation (quoting on Windows is the classic failure here — test it with a
    prompt containing quotes, `$`, `%` and backticks).
12. **Paths.** `BASE`, `NIGHT_DIR` and worktree paths are used with forward slashes everywhere they
    reach git, gh, Claude or `settings.local.json` (`D:/AI/...`); PowerShell file APIs accept both.
    Worktrees under `NIGHT_DIR/wt/<id>` as on Linux.

## 5. The launch line the skill prints on Windows (PHASE E)

```
pwsh -NoProfile -File "<skill dir>/windows/run.ps1" --config "<NIGHT_DIR>/config.env" --deadline <epoch>
```

run in a separate PowerShell window the owner may close later (the runner must survive the
window closing: launch it via `Start-Process pwsh ... -WindowStyle Hidden` from that line, i.e. the
printed line is itself a `Start-Process` one-liner, and the console output goes to
`logs/console.log`). Same flags as `run.sh` (`--config`, `--deadline`, `--smoke`, `--dry-run` if
present in run.sh — mirror exactly what run.sh accepts).

## 6. Acceptance criteria — EVIDENCE per item or FAIL (the reviewer runs these on the laptop)

Tests must never touch the real project or the real `NIGHT_DIR`: every test uses a temp
`NIGHT_DIR` and a temp git repo as `BASE`, and a **fake `claude`** shim (`claude.cmd` placed first on
PATH for the test) that sleeps N seconds, optionally prints a given log tail, prints a `RESULT`
line and exits with a chosen code. `gh` is faked the same way where a PR state is needed.

1. Config validation: each required key missing/invalid → exit 2 with the key named; injection
   guard characters rejected; optional keys default correctly.
2. Queue parsing: valid rows accepted; bad id/slug/note/needs produce the exact `BLOCKED-*` tokens
   from Appendix A §3 in the state file.
3. Lock: a second runner on the same config exits 3 within 10 s while the first holds the lock;
   killing the first (process tree) releases it without any file deletion; `run.flock` still exists.
4. Story run: fake claude with rc 0 → state row `<id> 0 <ISO>`; `logs/<id>.log` contains the RESULT
   line; `BRIEF-<id>.md` is read-only, contains no `{{` after substitution, and holds literal epoch
   integers; runner log has `START`/`END` lines in the Appendix A §9 format.
5. Timeout: fake claude that spawns a child and sleeps past `PER_STORY_TIMEOUT` → row rc `124`,
   and NO process of that tree is alive afterwards (assert via the job object / process enumeration).
6. Quota: fake claude rc 1 whose log ends with `You've hit your usage limit ... resets 3:30pm (Europe/Budapest)`
   → `DEFERRED-quota "resets=<ISO>"`, `quota-until` = reset + `QUOTA_MARGIN_SEC`; a "weekly" variant
   → `DEFERRED-quota-weekly` and the run finishes without waiting; a log with no parseable time →
   `resets=unknown` and fallback wait; the 6-hour cap and `QUOTA_MAX_WAITS` refuse correctly;
   `STOP` during a quota wait aborts within 5 s.
7. Deadline: a story whose remaining budget ≤ 0 → `BLOCKED-deadline`, no launch.
8. `state.txt` content equals `state-<date>.txt` after every row; an old `state.txt` from a previous
   night is moved to `state-before-<date>.txt`.
9. Report: `REPORT-<date>.md` deterministic sections are generated for a fixture state file and
   compared line-by-line against the bash runner's output for the same fixture (fixture + expected
   output provided in `tests/windows/fixtures/`; the VM session will supply the bash-generated
   expected file on request — ask brain_night_run). Narrative step skipped when quota is armed.
10. Watcher: with the runner killed, one tick reports `DEAD` and restarts it with the exact argv from
    `run.args`; a third death is not restarted (`WATCH_MAX_RESTARTS=2`); heartbeat older than 180 s
    → `STALLED`; disk floor breach writes `STOP` once and reports `DISK-LOW`; `finished` marker from
    a previous night (older than `started_epoch`) is ignored.
11. Cleanup: `worktree-cleanup.ps1` dry-run by default; `--apply` removes only trees that are clean,
    pushed, PR `MERGED` (fake gh) and not parked/blocked; exit codes 0/1/2 as specified; never
    `--force`.
12. Smoke: `run.ps1 --smoke` against a temp repo with the fake claude ends with `SMOKE OK <branch>`
    as the last line of `logs/smoke.log`.
13. Prompt quoting: the exact prompt string reaches the fake claude intact (the shim writes its
    argv to a file; assert byte equality) including `"`, `$`, `%`, backtick and newlines.
14. Nothing outside `NIGHT_DIR`, `BASE` and `%TEMP%` is created or modified by any test (snapshot
    `%USERPROFILE%` recursively before/after — names and sizes only).
15. The VM is unaffected: the PR changes no bash file's behaviour (`git diff --stat` on `run.sh`,
    `night-watch.sh`, `worktree-cleanup.sh` is empty; template changes are comment-only and the
    bash-side tests in the repo still pass on the VM — brain_night_run runs them on request).
16. Real run on the owner's project: after all of the above, ONE real story from the owner's
    queue (the owner picks it; the laptop session prepares the queue with `/bajzi:night-run`
    PHASE A–D exactly as on the VM) runs to a `RESULT` line, and the morning report exists.

## 7. Process rules for the laptop session

- Work in a clone of `bajzaa975/claude-alapcsomag` on the laptop, branch `feat/night-run-windows`
  (this spec is already on that branch; `git fetch && git checkout feat/night-run-windows`).
- Sub-agents write the code; disjoint file ownership; a FRESH reviewer sub-agent runs §6 and reports
  EVIDENCE per item or FAIL; fix rounds capped at 3, then park with the fix list.
- Commit in English, small commits, push the branch, open ONE PR to `main` titled
  `feat(night-run): native Windows runner (PowerShell 7) — story W1`. Do NOT merge, do NOT bump the
  plugin version, do NOT touch `.github/`.
- Message `brain_night_run` (cross-session) at: spec received; §6 first full pass result; PR
  opened; and whenever a contract question in Appendix A is ambiguous — ask, do not guess.
- Publish ONE owner-facing artifact page titled "Windows Night Run" with: what works, what the
  owner must do (numbered, exact commands), and the PR link. Update it in place; never a second page.

## Appendix A — the bash runner's contract (extracted from run.sh, night-watch.sh, worktree-cleanup.sh, SKILL.md, templates on main @ 1.5.15)

### A1. Inputs
config.env (`KEY="value"` lines). Required, runner refuses to start if any is empty: `PROJECT`, `NIGHT_DIR` (abs dir, must pre-exist), `BASE` (abs checkout dir, story cwd), `REPO` (`owner/name`, gh arg only, never a path), `BASE_BRANCH`, `MODEL` (e.g. `claude-fable-5-1`), `PER_STORY_TIMEOUT` (whole seconds, min 60), `BRANCH_PREFIX` (`[A-Za-z0-9._-]`), `DISK_FLOOR_GB` (whole GB), `REQUIRED_CHECK` (CI check name), `GIT_USER_NAME`, `GIT_USER_EMAIL`. Values must not contain newlines or `` ` `` / `$(` / `${`. Optional with defaults: `CI_WAIT_MINUTES=45` (min 1), `WATCH_INTERVAL=900` (0 = off), `WATCH_MAX_RESTARTS=2`, `WATCH_NOTIFY_CMD=""` (called with one arg = message), `QUOTA_MARGIN_SEC=180`, `QUOTA_MAX_WAITS=3`, `QUOTA_FALLBACK_WAIT_SEC=1800`, `QUOTA_MAX_WAIT_SEC=21600`.

queue.txt: one line per story, `#` = comment: `<id>|<slug>|<needs>|<note>`. id `[A-Za-z0-9._-]`, not starting with `-` or `.`; slug `[A-Za-z0-9._-]`, branch = `feat/<BRANCH_PREFIX>-<id>-<slug>`; needs `-`/`none`/empty = no dependency, else digits = PR number that must be `MERGED` (`gh pr view <n> -R <REPO> --json state --jq .state`); note = acceptance criteria, real text required (empty/`-`/`none`/`n/a`/`TBD` → `BLOCKED-criteria`).

BRIEF.md.tmpl placeholders substituted once by the planning phase: `{{PROJECT}} {{REPO}} {{BASE}} {{BASE_BRANCH}} {{BRANCH_PREFIX}} {{NIGHT_DIR}} {{MODEL}} {{REQUIRED_CHECK}} {{PER_STORY_TIMEOUT}} {{NIGHT_RULES}} {{RUN_DATE}} {{QUEUE_TABLE}}`. Runner-owned, substituted per story into `BRIEF-<id>.md`: `{{STORY_DEADLINE_EPOCH}} {{STORY_FINALIZE_EPOCH}} {{CI_WAIT_MINUTES}} {{GIT_USER_NAME}} {{GIT_USER_EMAIL}}`. Any `{{...}}` left → `BLOCKED-brief`.

settings.local.json at `<BASE>/.claude/settings.local.json`: allow entries scope `git -C <BASE|NIGHT_DIR/wt/*>` to fetch/worktree/status/diff/log/add/commit/merge origin/<BASE_BRANCH>/push HEAD or `feat/<PREFIX>-*`, plus `gh pr create --base <BASE_BRANCH>*`, `gh pr view|list|diff:*`, `gh run list:*`, `gh run view --json*`, `gh pr merge * --squash`, `brain:*`, `update-monitor note:*`. deny blocks `git push --force/-f/--mirror/--delete/--tags`, `reset --hard`, `clean -f/-x`, `rebase`, `stash`, `branch -D/-d`, `worktree remove --force/prune`, `filter-branch`, `update-ref`, `gh pr merge --admin/-R/--repo/--delete-branch`, `sudo`, `docker`, `systemctl`, `kill -9/-KILL`, plus `Edit(...)` deny globs for `.github/**`, other project trees, `BRIEF*.md`, `queue.txt`, `state*.txt`, `config.env`, the deployed tree, and `Read(...)` deny for `.env`, `~/.ssh/**`, `~/.aws/**`, `~/.config/gh/**`. Without this file every headless session stalls on a permission prompt until timeout.

### A2. Layout under NIGHT_DIR
`queue.txt`, `BRIEF.md`, `BRIEF-<id>.md` (read-only), `state-<RUN_DATE>.txt`, `state.txt` (→ newest), `state-before-<date>.txt`, `REPORT-<date>.md`, `worktrees.tsv` (`id\tpath\tbranch\tISO`), `wt/<id>/`, `logs/` (`runner.log`, `<id>.log`, `report.log`, `smoke.log`, `runner-restart-<n>.log`, `console.log`), `run.flock` (the lock, never unlinked), `run.lock` (pgid text, atomic), `run.args` (argv one per line, argv[0] first), `run.meta` (`pgid started_epoch deadline_epoch run_date base night_dir skill_dir config mode`), `heartbeat`, `story/<id>.sid`, `quota-until` (epoch), `finished` (epoch), `STOP` (owner kill switch, never removed by the runner), `watch.pid`, `watch.status`, `watch.restarts`, `watch.log`.

### A3. State file
Row: `<id> <rc|TOKEN> <ISO-UTC> [reason]`, appended, literal-id matched. Last row per id = outcome. Numeric rc = story ran. Terminal tokens: `BLOCKED-queue`, `BLOCKED-criteria`, `BLOCKED-needs`, `BLOCKED-needs-unknown`, `BLOCKED-brief`, `BLOCKED-deadline`. Retryable: `DEFERRED-needs "pass N: PR #n not merged yet"`, `DEFERRED-quota "resets=<ISO|unknown>"`, `DEFERRED-quota-weekly "resets=<ISO>"`, `DEFERRED-alive "sid=<pid>"`; `INTERRUPTED`. The story session's own line, in `logs/<id>.log` only, never parsed into state: `RESULT <id> <merged|open|parked|blocked> PR#<n|-> review=<pass|parked> rounds=<n> reason=<review|timeout|context|ci|forbidden|merge-forbidden|tests|->`.

### A4. Launch
Budget = `min(PER_STORY_TIMEOUT, DEADLINE_EPOCH - now)`; ≤0 → `BLOCKED-deadline`. `deadline = now+budget`, `finalize = now + budget*85/100`, literal ints in the brief. Invocation: `setsid timeout -k 60 <budget> claude -p "<prompt>" --permission-mode <PERM_MODE:auto> --model <MODEL> --output-format text </dev/null`, cwd BASE, env `STORY_DEADLINE_EPOCH STORY_FINALIZE_EPOCH CI_WAIT_MINUTES GIT_USER_NAME/EMAIL GIT_AUTHOR_* GIT_COMMITTER_*`, `CLAUDECODE` unset, no `--max-turns`. Prompt: one paragraph — invoke `bajzi:autopilot` scoped to this story, read `BRIEF-<id>.md` and obey it, state both epochs, `CI_WAIT_MINUTES`, the `git -c user.name -c user.email commit` identity, branch/worktree naming, end with the exact RESULT grammar. Liveness: pid state ≠ zombie, backoff 1→20 s, heartbeat each poll; after exit TERM every pid in the session, wait ≤20 s, then KILL. Quota classification only when rc ≠ 0: last 40 non-blank log lines, `hit your .*limit` case-insensitive; "weekly" → `DEFERRED-quota-weekly`; reset from `resets <H:MM[am|pm]>` or bare `HH:MM`, optional `(zone)`; candidates yesterday/today/tomorrow in that zone, earliest not older than now-900 s; ≤ now → now; unparseable → now + `QUOTA_FALLBACK_WAIT_SEC`, `resets=unknown`. `quota-until = reset + QUOTA_MARGIN_SEC`, checked before every launch. Wait refused (run finishes, rows stay DEFERRED) if weekly, wait > `QUOTA_MAX_WAIT_SEC`, already waited `QUOTA_MAX_WAITS` times, or < 60 s would remain before `--deadline`; else sleep in ≤5 s slices checking `STOP`, beating heartbeat.

### A5. Report
`REPORT-<RUN_DATE>.md`: deterministic part first — `# Night report — <PROJECT> — <RUN_DATE>`, `## Counts` (queue lines with a row / done / failed / deferred / blocked / interrupted from each id's last row), `## Stories` (`| id | outcome | time (UTC) | reason | RESULT line |`, queue order plus ids in state no longer queued; no row → `not reached`), `## Quota`, `## Runner facts` (state path, runner log path, deadline, BASE, NIGHT_DIR). Then `## Narrative` appended by one `claude -p` session (`timeout -k 60 1800`; skipped when quota armed) that reads state, runner.log, `RESULT` lines, `runtime/AUTOPILOT-REPORT.md`, `runtime/handoff/night-*.md`, `runtime/DECISIONS.md`, `gh pr list`, `brain next`, and ends with stdout `REPORT WRITTEN <path>`; never rewrites the deterministic part.

### A6. Watcher
Tick every `WATCH_INTERVAL` in ≤60 s slices. Checks: runner alive (lock probe: acquired ⇒ DEAD, refused ⇒ ALIVE, error ⇒ UNKNOWN fail-closed); heartbeat age vs 180 s ⇒ `STALLED`; disk floor min(free BASE, free NIGHT_DIR) vs `DISK_FLOOR_GB`, unreadable = breach, writes `STOP` once ⇒ `DISK-LOW`; `quota-until` vs now ⇒ `QUOTA-WAIT`; queue progress from queue.txt and state.txt; orphans per `story/<id>.sid` (reported, never signalled). Restart budget `WATCH_MAX_RESTARTS` in watcher memory, re-exec exact `run.args`, skipped within 10 min of `deadline_epoch`. Markers dated against `run.meta started_epoch` (STOP: the earlier of that and the watcher's own start). One stdout line per tick: `OK STALLED QUOTA-WAIT DISK-LOW RESTARTED DEAD FINISHED STOPPED EXPIRED UNKNOWN`. `update-monitor note` and `WATCH_NOTIFY_CMD` only on transitions and restarts; optional.

### A7. Locking
Exclusive lock held for the runner's life on a never-deleted file; OS releases on death. Identity by argv (script name + config path), never process counts, never text patterns that match the checking shell, never "same group". A failed scan = unknown = fail closed. After locking: re-verify own identity in a fresh scan, wait ≤10 s for a lingering rival with the same config; delete night-scoped markers (`finished`, restart hint) before publishing anything.

### A8. worktree-cleanup
`--config <path>`, `--apply` (else dry-run), `--no-fetch` (dry-run forced; exclusive with `--apply`/`--prune`, exit 2), `--prune` (opt-in). Reads only `worktrees.tsv`; every unanswered check = KEEP; remove only when unused, not parked/blocked, branch on origin, clean and pushed, PR `MERGED`; `git worktree remove` without `--force`. Exit 0 nothing to do, 1 something kept for review, 2 usage/config error.

### A9. Exit codes and parsed lines
run: 0 normal (after report), 2 usage/config, 3 lock held (or rival still exiting after 10 s), 4 disk below floor at startup, 130/143 on interrupt/terminate after killing the story and releasing the lock. Story rc (e.g. 124/137) is recorded in state, not returned. SKILL.md parses from its own shell: `CONFIG PRESENT` / `FIRST RUN — no config.env yet`; `BLOCKER: ...`; `RUNNER SCAN FAILED (pgrep rc=$rc)`; bare pgid list (0/1/≥2); `NO RUNNER` / `RUNNER ALIVE (run.lock says pgid ...)`. runner.log lines (`<ISO-UTC> <text>`): `RUN start (project=... ...)`, `START <id> (budget ...)`, `END <id> rc=<n> token=<TOKEN> RESULT ...`, `QUOTA-WAIT until <ISO> (<n> min)`, `QUOTA-WAIT over (until <ISO>)`, `SKIP <id> ...`, `BLOCKED <id> ...`, `run lock taken: ...`, `FINISHED <epoch>`. Smoke: last line of `logs/smoke.log` = `SMOKE OK <branch>`.
