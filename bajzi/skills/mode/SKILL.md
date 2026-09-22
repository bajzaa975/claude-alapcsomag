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
  4. the saver level, read from `$HOME/.claude/worker-mode` with the same read as above:
     `light`, `glm` and `tight` print `saver: L1 (light)` / `saver: L2 (glm)` /
     `saver: L3 (tight)`, `claude` prints `saver: off`, and a missing file prints
     `saver: off (no worker-mode file)`. Never write that file from this skill.

## Saver levels (GLM rungs under day-run)

Saver mode adds cheaper GLM rungs UNDER the day-run routing table: the task classes a level
lists are dispatched to a headless GLM worker via `glm -p "<task>"` instead of the Agent
tool, so they cost no Anthropic quota. Task classes, ordered by risk (how far a mistake
travels before something catches it): 1 search/locate, 2 tests/lint/build, 3 long-file
summaries, 4 first-round fixes, 5 implementing.

| Level | GLM flash (`glm-5.3-flash`) | GLM big (`glm-5.3`) | Stays on Claude | Target GLM share |
|---|---|---|---|---|
| **L0 Claude** | - | - | everything | 0% |
| **L1 Light** | 1-3 (replaces haiku) | - | 4-5 (sonnet), orchestration + every review (Opus) | 20-30% |
| **L2 Balanced** | 1-3 | 4-5 | orchestration, every review, risk-bearing slices (Opus) | 60-70% |
| **L3 Tight** | 1-3 | 4-5, orchestration, Tier-2 findings | Tier-1 + final whole-branch reviews - **queued** (SAVER-L3.md) | 85-90% build-phase |

Fixed rules, all levels: flash never writes code (classes 4-5); risk-bearing slices never
start on GLM below L3; GLM never reviews GLM's code as a substitute for an Opus review -
where no Opus review is available the review is queued, never downgraded; the GLM
peak-window ban applies at every level that uses GLM (L1-L3), enforced by the shim.

- `worker --level N` sets the level (0=claude, 1=light, 2=glm, 3=tight); `worker --status`
  prints the level, the GLM models and the state files; `worker --usage <since> --until <t>`
  reports the Anthropic/GLM weighted-token split since a time. Those commands come from the
  owner's `worker` wrapper (`bin/cc-router.js`), not from this plugin - this skill only
  READS `$HOME/.claude/worker-mode` and never writes it.
- Levels apply only while day-run is on. In normal mode the SessionStart hook emits `{}` and
  saver mode has no effect at all. A non-Anthropic provider forces L3 whatever the file says.
- The hook injects the level's rules text (`SAVER-L1.md`, `SAVER-RULES.md` as the L2 text,
  `SAVER-L3.md`) only when `worker-mode` names a level AND the `glm` launcher is on PATH AND
  the text exists, so a machine without the wrapper never gets told to call a command it
  does not have.

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
