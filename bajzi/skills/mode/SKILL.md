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

- `--project` given -> write/read `<repo>/runtime/bajzi-mode`.
- `--project` not given -> write/read `$HOME/.claude/bajzi-mode`.
- Resolution order when reading the EFFECTIVE mode (for `status`, and mirrored by the hook): the
  project file wins. Check `runtime/bajzi-mode` first; only if it is absent or empty, fall back
  to `$HOME/.claude/bajzi-mode`.

## Reading a mode file

Read exactly like this. This read must stay byte-identical to the read in
`bajzi/hooks/day-run-mode.sh` - if the two drift apart, the skill and the hook will disagree
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
  `${CLAUDE_PLUGIN_ROOT}/skills/mode/DAY-RUN-RULES.md` (it is capped at 40 lines - never read a
  bigger file in its place) and restate its rules as the active rules for the rest of this
  session.
- `normal`: write `normal` to the resolved target file. State plainly that the day-run rules no
  longer apply in this session.
- `status`: print exactly three short lines, no file dumps:
  1. effective mode (`day-run` or `normal`; a missing or unreadable file reports as "not set -
     the plugin behaves as normal; run /bajzi:mode day-run to enable"),
  2. which file it came from (`runtime/bajzi-mode`, `~/.claude/bajzi-mode`, or "none"),
  3. whether a project override is in force (a `runtime/bajzi-mode` present and different from
     the user-level file - yes/no).

## Pointers

Day-run dispatches sub-agents using the four templates in
`skills/mode/templates/dispatch-{explore,implement,review,fix}.md`, and appends one line per
dispatch to `runtime/DAY-RUN.log` in the format
`<ISO time> <task-class> model=<name> rounds=<n> result=<pass|fail|park|direct>`.

## Standing constraints (this skill, always)

- Git: only `/usr/bin/git`, one git command per Bash call, ever.
- This skill never runs `git merge` or `git push`, and never merges anything into anything.
- `kill` is banned - never run it, from this skill or from anything it dispatches.
- This skill never runs `claude` as a subprocess - no sub-invocations of the CLI, ever.
- Never read a file over 300 lines as part of this skill's own work (the mode files are one
  line each; the rules file it reads on a day-run switch is capped at 40 lines).
- English only, ASCII only, in everything this skill writes or prints.
