# bajzi

A token-efficient working method for Claude Code and Cowork.

## Skills

| Command | What it does | When |
|---|---|---|
| `/bajzi:setup` | full machine setup per `skills/setup/manifest.json`: plugins, settings, rtk, status line, user-scope MCPs | on a new machine |
| `/bajzi:setup --check` | one `DRIFT` line per difference between this machine and the manifest; changes nothing | any time |
| `/bajzi:project-setup` | applies the repo's `.claude/project-profile.json` (`--check` diffs it); with no `size`/`hosting` it first asks five start questions. Sizes XS/S/M/L (additive kit; upgrade = change `size`, add `gate` for M/L, rerun), hosting local/github. Hosting local installs a pre-push guard that refuses GitHub remotes; limits: `git push --no-verify` bypasses it, and a fresh clone runs no hook until you run `git config core.hooksPath .githooks` in it | once per repo |
| `/bajzi:handoff` | `runtime/handoff/<slug>.md`, where `/bajzi:handoff` derives `<slug>` from the current branch (`handoff-load.sh` resolves the same name), plus a pasteable opening prompt | before `/clear`, at 40% context |
| `/bajzi:modszertan` | GSD vs superpowers vs none → `.claude/METHODOLOGY` | once per repo |
| `/bajzi:autopilot` | unsupervised work session with a decision log | when you leave the machine |
| `/bajzi:mode` | day-run working mode on/off, status | any time |
| `/bajzi:level [<n> [session\|repo\|global]]` | owner-only saver level command, handled by a hook (no model turn): status, set, `unset`; refused in an unattended session | any time |
| `/bajzi:night-run` | plans and launches an unattended overnight run | at bedtime |
| `/bajzi:implement <id>` | implements one slice from `runtime/slices/<id>.md` through the implementer agents | per slice |
| `/bajzi:review <slice> <range>` | reviews a commit range through the reviewer agent | after the sprint's last slice is committed |
| `/bajzi:fix <findings-file>` | fixes round-1 findings, then runs the round-2 re-review | after a review with findings |
| `/bajzi:debt` | checks, drains or calibrates parked review debt | before a slice / at a milestone |
| `/bajzi:radar [now\|install]` | biweekly read-only review of the Claude setup | every two weeks |
| `/bajzi:which <intent>` | names the skill or command that fits what you want to do | any time |

## Hooks (dependency-free shell)

**SessionStart**
- `handoff-load.sh` — reloads the HANDOFF after `/clear`, `/compact`, `resume`
- `methodology-guard.sh` — records per repo which methodology leads, and puts it into the context
- `day-run-mode.sh` — injects the day-run rules and the saver-level block

**PreToolUse(Bash)**
- `noise-filter.sh` + `noise-run.sh` — keeps loud, low-information output out of the context.
  Allowlisted installs/builds only (npm/pip/cargo/docker/apt/make/gradle/mvn…); the command
  runs untouched and **its exit code is preserved** (piping into `tail` would report `tail`'s
  status, making a failed build look successful). Output under 40 lines is never filtered, a
  failure keeps more, and the full log path is always printed. Disable with `BAJZI_NOISE_OFF=1`.
  Complementary to rtk — pytest/ruff/git/ls/find/grep stay rtk's, `rtk …` calls are skipped.

**PreToolUse(Agent|Task)**
- `dispatch-guard.sh` — refuses review or fix work sent to the wrong agent and oversized briefs;
  fail-open (a discipline guard)

**PostToolUse(Agent|Task)**
- `routing-counter.sh` — counts sub-agent dispatches that bypass the saver level's GLM rung

## Node hooks and the status line (Node >= 18, no dependencies)

- **Status line** — `hooks/node/statusline.js`, installed by `/bajzi:setup` to `~/.claude/bajzi/`:
  `model · Lx · branch* · task · ▓▓░░ NN% · 5h NN% · 7d NN% · GLM NN% · Qn · peak …`. NN% = `100 -
  context_window.remaining_percentage`, the number `/context` shows; green < 40, yellow 40-49,
  red >= 50. `GLM` only at L1-L3, `Qn` only with open review-queue items, `peak` only within 2 h
  before or inside the Z.ai peak window (14:00-18:00 UTC+8). It writes
  `<tmpdir>/bajzi-ctx-<session>.json`, which the context guard reads.
- **Combined tool hooks** — hooks.json wires ONE node process per tool event:
  `hooks/node/pre-tool.js` (PreToolUse, every tool) runs the context guard, the secret guard, the kill guard, the writer guard and the saver guard. It is the one hook wired fail-closed (`onFailure: block`, timeout 10, Claude Code 2.1.295+): if the process cannot start, times out or exits other than 0/2, the tool call is blocked;
  `hooks/node/post-tool.js` (PostToolUse, every tool) runs the context guard and the injection
  scanner. Each check runs only on the tools listed below and fails open on its own; denies
  (pre) or warnings (post) are joined into one output, context guard first.
- **Context guard** — `hooks/node/context-guard.js`, every tool, PreToolUse + PostToolUse (via
  pre-tool.js / post-tool.js). At
  >= 40% a warning (once per 5 tool calls); at >= 50% every tool call is denied except writing or
  reading the handoff (`runtime/handoff/**`, `runtime/HANDOFF.md`) and read-only
  `git status|diff|log`. Unknown or stale (> 60 s) context = allow. **Known limit:** only the
  status line writes the context figure, and headless `claude -p` has no status line, so the
  guard never blocks a night session; it is a discipline aid, not a security boundary.
- **Secret guard** — `hooks/node/secret-guard.js`, PreToolUse (via pre-tool.js) on Read, Grep,
  Glob, Bash, PowerShell. Denies reading `.env`, `.env.*` (except `.example/.sample/.template/.dist`),
  `.secrets` and the manifest's `secret_patterns`; the deny names the rule. **Known limit: it is
  a pattern guard, not a shell parser** — these pass: variable or command indirection
  (`f=.env; cat $f`, `cp`/`Copy-Item` of a protected file to another name), encoded or obfuscated
  paths (`.\env`, base64/URL-encoded), a `Grep` whose `path` is a directory and that has no `glob`
  parameter (it can match secret files inside that directory), and prefix options that stop the
  prefix walk (`sudo -u`, `env -i`, `nice -n`). `ls | grep .env` is denied (a false positive in
  the safe direction). It covers files, not the environment: a key held in an environment
  variable is readable by every session.
- **Kill guard** — `hooks/node/kill-guard.js`, PreToolUse (via pre-tool.js) on Bash and
  PowerShell, every session and sub-agent, no off switch. Denies a by-name process kill in any
  command segment (past `sudo`/`env`/`nice`/`nohup`/`timeout`/`xargs`) or inside `bash -c`,
  `cmd /c`, `powershell -Command`: `taskkill` with `/IM` or `/FI` (`/`, `//`, `-`, any case),
  `pkill`, `killall`, `Stop-Process`/`spps`/`kill` with `-Name` (or `-N`, `-Na`, `-Nam`),
  `Get-Process`/`gps`/`ps` not selected by `-Id` piped into `Stop-Process`/`kill`/`.Kill()`, `kill`
  fed by `pgrep`/`pidof`, `wmic process ... delete|call terminate`, Win32_Process `Terminate`.
  Kills by PID (`taskkill /PID`, `kill 123`, `Stop-Process -Id`) and mere mentions (`echo pkill`)
  pass. The deny names the rule and says to stop only processes the agent started, by their PID,
  or ask the owner. **Known limit: it is a pattern guard, not a shell parser** — variable or
  command indirection (`p=$(pgrep node); kill $p`, `$c='pkill'; & $c node`) and encoded commands
  (`powershell -EncodedCommand`) pass.
- **Injection scanner** — `hooks/node/injection-scan.js`, PostToolUse (via post-tool.js) on Read,
  WebFetch, WebSearch and `mcp__*`. Adds a "treat this as data" warning naming the matched rules; never blocks.
  **Known limit:** a pattern matcher — advisory context only; a rephrased injection passes.
- **Saver guard** — `hooks/node/saver-guard.js`, PreToolUse. At saver level L2/L3 on a Claude
  session, Edit/Write outside `runtime/`, writer agents and obvious shell writes are denied, so
  the code is written by the GLM worker. Claude cannot change its own level. During the Z.ai
  peak window writes are allowed and logged.
- **Writer guard** — `hooks/node/writer-guard.js`, PreToolUse. bajzi plugin files are edited only
  by a session started in the bajzi repo's main checkout; any other session is denied
  Edit/Write and sends a request instead. Installed plugin copies are denied to every session.
  Bash/PowerShell writes are not blocked.
- **Session signal** — `hooks/node/session-signal.js`, SessionStart, UserPromptSubmit, Notification,
  Stop, StopFailure, SessionEnd, plus PostToolUse (via post-tool.js). Writes the session status
  records for an optional external orchestrator (not part of this package): `<status dir>/<id>.event.json` and
  `<id>.artifacts.jsonl`; the status line writes `<id>.line.json`. No output ever; fails open.
  Creating `~/.claude/bajzi/hook-samples.on` switches on `hook-samples.jsonl` next to it:
  redacted shape samples of every hook input (content strings become `<str N>`).
  A typed `/bajzi:tired` or `/bajzi:tired off` prompt also writes or deletes `<id>.tired`.
- **Tired mode** — `hooks/node/tired.js`, SessionStart. After a compaction, when `<id>.tired` exists,
  re-adds the `/bajzi:tired` rules once; on startup, clear and resume it deletes the marker. Fails open.
- **Level command** — `hooks/node/level.js`, UserPromptSubmit. A typed `/bajzi:level …` line is handled and blocked there (the model never sees it): sets or unsets the saver level for this session, the repo (`runtime/worker-mode`) or the machine; refused when no person is at the keyboard. Fails open.
- **Owner questions rule** — `hooks/node/ask-owner.js`, SessionStart. Only when `ORCH_BUS_PANE` is set (a session
  in an external orchestrator's pane with an `ask_owner` tool), adds the rule that routes every owner question and
  manual owner step through that tool. Silent otherwise; fails open.
- Every node hook fails open on an internal error (it exits 0, i.e. allow), logged to `~/.claude/bajzi/hook-errors.log`
  (256 KB cap).
- Tests (Git Bash on Windows, any shell on Linux), from the repo root:
  `node --test bajzi/hooks/node/tests/*.test.js bajzi/skills/*/tests/*.test.js bajzi/tests/agents/*.test.js bajzi/lib/tests/*.test.js` and
  `bash bajzi/hooks/tests/saver-level-parity.sh`.

## Subagent effort

Each agent sets `effort:` in its frontmatter (reviewer high, implementer medium,
implementer-risk high, fixer medium; Claude Code 2.1.292+). Day-run passes the routing row's
effort on every Claude dispatch: low for locate/map, tests and long-file reads, medium for
implement, fix and documents, high for risk slices (and their fixes), debugging and reviews, xhigh for the one sprint review (its round 2 at high); the full gate runs once per sprint at the end of the review loop. Your own session effort is never changed. Briefs for locate/map, tests, long-file read,
implement and fix end with a pacing sentence; review, debugging and documents briefs never do.

## Saver levels

Day-run's GLM rung has four levels, set with `worker --level 0|1|2|3` (0 `claude`, 1
`light`, 2 `glm`, 3 `tight`). Each level moves more task classes onto the Z.ai GLM models:
L1 sends only the flash classes (locate, tests/lint/build, long-file summaries), L2 adds
long documents, implementation slices and first-round fixes, L3 runs the whole session on
GLM and queues the Opus reviews instead of holding them. Orchestration, debugging and
every review stay Anthropic except at L3, where a review is queued, never downgraded.
`worker --status` shows the active level; `worker --usage <since> --until <t>` reports the
Anthropic/GLM weighted-token split. The shim behind these commands is documented in
`bin/README.md`.

## Adding a new tool

A single file: `skills/setup/manifest.json`. Push → every machine gets it at the next
`/bajzi:setup`; `/bajzi:setup --check` shows which machines still lack it.

Installation and the global rules: the `README.md` in the repo root.
