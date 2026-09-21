# /bajzi:mode

Sets the working mode for this session or a project: `day-run` (opus/sonnet/haiku
task routing plus stricter session discipline), `normal` (no routing changes), or
`status` (report the effective mode). No argument = `status`.

## Arguments

- `day-run` - turn day-run mode on.
- `normal` - turn day-run mode off.
- `status` - report the effective mode, its source file, and any project override.
- `--project` - target the current repo instead of the whole machine.

## Where the mode lives

- Global: `~/.claude/bajzi-mode`
- Project override: `<repo>/runtime/bajzi-mode`

A project file wins over the global file when both exist. A missing file means
normal mode: the plugin behaves exactly as it did before this skill existed.

Saver mode: while day-run is on and `~/.claude/worker-mode` says `glm`, `SAVER-RULES.md` is injected too and the cheap rungs run on a headless GLM worker (`worker --set claude` turns it off).

## Turning injection off

Delete the mode file, or write `normal` into it (`/bajzi:mode normal`). Either
way, the SessionStart hook stops injecting the day-run rules block.

## Full rules

See `DAY-RUN-RULES.md` in this directory for the complete day-run rule set that
gets injected into the session.
