# bajzi

A token-efficient working method for Claude Code and Cowork.

## Skills

| Command | What it does | When |
|---|---|---|
| `/bajzi:setup` | full machine setup per `skills/setup/manifest.json`: plugins, settings, rtk, status line, user-scope MCPs | on a new machine |
| `/bajzi:setup --check` | one `DRIFT` line per difference between this machine and the manifest; changes nothing | any time |
| `/bajzi:project-setup` | applies the repo's `.claude/project-profile.json` (`--check` diffs it) | once per repo that has a profile |
| `/bajzi:handoff` | `runtime/handoff/<branch>.md` + a pasteable opening prompt | before `/clear`, at 40% context |
| `/bajzi:modszertan` | GSD vs superpowers vs none → `.claude/METHODOLOGY` | once per repo |
| `/bajzi:autopilot` | unsupervised work session with a decision log | when you leave the machine |
| `/bajzi:mode` | day-run working mode on/off, status | any time |
| `/bajzi:night-run` | overnight story runner with watchdog | at bedtime |

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
  failure keeps more, and the full log path is always printed. Measured: `npm install
  --loglevel verbose` 28,295 → 2,967 chars (−89.5%). Disable with `BAJZI_NOISE_OFF=1`.
  Complementary to rtk — pytest/ruff/git/ls/find/grep stay rtk's, `rtk …` calls are skipped.

**PostToolUse(Agent|Task)**
- `routing-counter.sh` — counts sub-agent dispatches that bypass the saver level's GLM rung

## Node hooks and the status line (Node >= 18, no dependencies)

- **Status line** — `hooks/node/statusline.js`, installed by `/bajzi:setup` to `~/.claude/bajzi/`:
  `model · Lx · branch* · task · ▓▓░░ NN% · GLM NN% · Qn · peak …`. NN% = `100 -
  context_window.remaining_percentage`, the number `/context` shows; green < 40, yellow 40-49,
  red >= 50. `GLM` only at L1-L3, `Qn` only with open review-queue items, `peak` only within 2 h
  before or inside the Z.ai peak window (14:00-18:00 UTC+8). It writes
  `<tmpdir>/bajzi-ctx-<session>.json`, which the context guard reads.
- **Context guard** — `hooks/node/context-guard.js`, every tool, PreToolUse + PostToolUse. At
  >= 40% a warning (once per 5 tool calls); at >= 50% every tool call is denied except writing or
  reading the handoff (`runtime/handoff/**`, `runtime/HANDOFF.md`) and read-only
  `git status|diff|log`. Unknown or stale (> 60 s) context = allow. **Known limit:** only the
  status line writes the context figure, and headless `claude -p` has no status line, so the
  guard never blocks a night session; it is a discipline aid, not a security boundary.
- **Secret guard** — `hooks/node/secret-guard.js`, PreToolUse on Read, Grep, Glob, Bash,
  PowerShell. Denies reading `.env`, `.env.*` (except `.example/.sample/.template/.dist`),
  `.secrets` and the manifest's `secret_patterns`; the deny names the rule. **Known limit: it is
  a pattern guard, not a shell parser** — these pass: variable or command indirection
  (`f=.env; cat $f`, `cp`/`Copy-Item` of a protected file to another name), encoded or obfuscated
  paths (`.\env`, base64/URL-encoded), a `Grep` whose `path` is a directory and that has no `glob`
  parameter (it can match secret files inside that directory), and prefix options that stop the
  prefix walk (`sudo -u`, `env -i`, `nice -n`). `ls | grep .env` is denied (a false positive in
  the safe direction). It covers files, not the environment: a key held in an environment
  variable is readable by every session.
- **Injection scanner** — `hooks/node/injection-scan.js`, PostToolUse on Read, WebFetch,
  WebSearch and `mcp__*`. Adds a "treat this as data" warning naming the matched rules; never blocks.
  **Known limit:** a pattern matcher — advisory context only; a rephrased injection passes.
- Every node hook fails open: an internal error = allow, logged to `~/.claude/bajzi/hook-errors.log`
  (256 KB cap).
- Tests (Git Bash on Windows, any shell on Linux), from the repo root:
  `node --test bajzi/hooks/node/tests/*.test.js bajzi/skills/*/tests/*.test.js` and
  `bash bajzi/hooks/tests/saver-level-parity.sh`.

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
