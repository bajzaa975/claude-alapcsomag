---
name: mode
description: Switch between day-run (autonomous, model-routed) and normal working mode, or report which one is active. Use it when the user says "mode", "day-run", "normal mode", "which mode am I in", or asks to turn day-run on or off.
---

# MODE - day-run vs normal

Day-run is an autonomous, model-routed working mode: the orchestrator model (ORCH) plans and
dispatches, sub-agents run at the cheapest model tier a task allows, and results come back as
short reports. Normal mode is plain, unrouted work. This skill switches between the two and
reports which one is active.

## Argument grammar

`day-run | normal | status`, optional `--project`. No argument means `status`. Any other
argument: print `day-run | normal | status [--project]` and stop - do nothing else.

## Where the mode lives

- `--project` given -> `<repo>` is the output of `/usr/bin/git rev-parse --show-toplevel`; if that
  fails (not inside a repo), refuse `--project` with a one-line message and stop. Otherwise
  write/read `<repo>/runtime/bajzi-mode`.
- `--project` not given -> write/read `$HOME/.claude/bajzi-mode`.
- Resolution order when reading the EFFECTIVE mode (for `status`, and mirrored by the hook): the
  project file wins. Check `runtime/bajzi-mode` first; only if it is absent or empty, fall back
  to `$HOME/.claude/bajzi-mode`.
- The hook reads the project override from the SESSION'S cwd (`<cwd>/runtime/bajzi-mode`), so an
  override written with `--project` only applies once the session starts at that repo's root.

## Reading a mode file

Read exactly like this. This read must stay byte-identical to the read in
`bajzi/hooks/lib-saver-level.sh` (sourced by the hooks) - if the two drift apart, the skill and the hook will disagree
about which mode is currently active:

`head -1 "<file>" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'`

Anything other than exactly `day-run` (a missing file, an empty file, or a garbage word) counts
as normal / not set.

## Writing a mode file

Atomic write, exactly as follows. The temp file lives in the SAME directory as the target, so
`mv` is a rename, never a partial write visible to a reader:

```
mkdir -p <dir>
t="<dir>/.bajzi-mode.$$"
printf '%s\n' <mode> > "$t" && mv -f "$t" "<dir>/bajzi-mode"
```

## Behavior per argument

- `day-run`: write `day-run` to the resolved target file (see "Where the mode lives" above).
  Then apply it to THIS session: read
  `${CLAUDE_PLUGIN_ROOT}/skills/mode/DAY-RUN-RULES.md` (it is capped at 80 lines - never read a
  bigger file in its place) and restate its rules as the active rules for the rest of this
  session. If saver mode is on (see below), also read
  `${CLAUDE_PLUGIN_ROOT}/skills/mode/SAVER-RULES.md` and apply it on top.
- `normal`: write `normal` to the resolved target file. State plainly that the day-run rules no
  longer apply in this session.
- `status`: print exactly four short lines, no file dumps:
  1. effective mode (`day-run` or `normal`; a missing or unreadable file reports as "not set -
     the plugin behaves as normal; run /bajzi:mode day-run to enable"),
  2. which file it came from (`runtime/bajzi-mode`, `~/.claude/bajzi-mode`, or "none"),
  3. whether a project override is in force (a `runtime/bajzi-mode` present and different from
     the user-level file - yes/no),
  4. the saver state, read from `$HOME/.claude/worker-mode` with the same read as above
     (`head -1 "<file>" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'`): `glm` prints
     `saver: on (worker-mode=glm)`, any other word prints `saver: off`, and a missing file
     prints `saver: off (no worker-mode file)`. Never write that file from this skill.

## Saver mode (GLM rung)

Saver mode adds one cheaper rung UNDER the day-run routing table: the task classes listed in
`skills/mode/SAVER-RULES.md` (locate/map, tests/lint/build, big reads, long documents, specified
slices, fix round 1) are dispatched to a headless GLM worker via `glm -p "<task>"` instead of the
Agent tool, so they cost no Anthropic quota. Risk-bearing slices, debugging, every review and all
ORCHESTRATOR-ONLY work stay exactly where the table puts them.

- Switch it on / off: `worker --set glm` / `worker --set claude`; `worker --status` shows it.
  Those commands come from the owner's `worker` wrapper, not from this plugin - this skill only
  READS `$HOME/.claude/worker-mode` and never writes it.
- It only applies while day-run is on. In normal mode the SessionStart hook emits `{}` and
  saver mode has no effect at all.
- The hook injects `SAVER-RULES.md` only when `worker-mode` says `glm` AND the `glm` launcher is
  on PATH, so a machine without the wrapper never gets told to call a command it does not have.

## Pointers

Day-run dispatches sub-agents using the four templates in
`skills/mode/templates/dispatch-{explore,implement,review,fix}.md`, and appends one line per
dispatch to `runtime/DAY-RUN.log` in the format
`<ISO time> <task-class> model=<name> rounds=<n> result=<pass|fail|park|direct>`. Before the first
append in a session, run `mkdir -p runtime`.

## Standing constraints (this skill, always)

- Git: only `/usr/bin/git`, one git command per Bash call, ever.
- This skill never runs `git merge` or `git push`, and never merges anything into anything.
- `kill` is banned - never run it, from this skill or from anything it dispatches.
- This skill never runs `claude` as a subprocess - no sub-invocations of the CLI, ever.
- Never read a file over 300 lines as part of this skill's own work (the mode files are one
  line each; the rules files it reads on a day-run switch are capped at 80 and 40 lines
  respectively).
- English only, ASCII only, in everything this skill writes or prints.
