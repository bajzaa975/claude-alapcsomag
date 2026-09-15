# bajzi

A token-efficient working method for Claude Code and Cowork.

## Skills

| Command | What it does | When |
|---|---|---|
| `/bajzi:handoff` | `runtime/HANDOFF.md` + a pasteable opening prompt | before `/clear`, at 40% context |
| `/bajzi:alapcsomag` | project layer: `.mcp.json`, context guard, HANDOFF skeleton | once in a new repo |
| `/bajzi:modszertan` | GSD vs superpowers vs none → `.claude/METHODOLOGY` | once per repo |
| `/bajzi:autopilot` | unsupervised work session with a decision log | when you leave the machine |
| `/bajzi:setup` | full machine setup per `skills/setup/manifest.json` | on a new machine |

## Hooks (dependency-free shell)

**SessionStart**
- `handoff-load.sh` — reloads the HANDOFF after `/clear`, `/compact`, `resume`
- `methodology-guard.sh` — records per repo which methodology leads, and puts it into the context

**PreToolUse(Bash)**
- `noise-filter.sh` + `noise-run.sh` — keeps loud, low-information output out of the context.
  Allowlisted installs/builds only (npm/pip/cargo/docker/apt/make/gradle/mvn…); the command
  runs untouched and **its exit code is preserved** (piping into `tail` would report `tail`'s
  status, making a failed build look successful). Output under 40 lines is never filtered, a
  failure keeps more, and the full log path is always printed. Measured: `npm install
  --loglevel verbose` 28,295 → 2,967 chars (−89.5%). Disable with `BAJZI_NOISE_OFF=1`.
  Complementary to rtk — pytest/ruff/git/ls/find/grep stay rtk's, `rtk …` calls are skipped.

## Adding a new tool

A single file: `skills/setup/manifest.json`. Push → every machine gets it at the next
`/bajzi:setup`.

Installation and the global rules: the `README.md` in the repo root.
