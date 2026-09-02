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

## Hooks (SessionStart, dependency-free shell)

- `handoff-load.sh` — reloads the HANDOFF after `/clear`, `/compact`, `resume`
- `methodology-guard.sh` — records per repo which methodology leads, and puts it into the context

## Adding a new tool

A single file: `skills/setup/manifest.json`. Push → every machine gets it at the next
`/bajzi:setup`.

Installation and the global rules: the `README.md` in the repo root.
