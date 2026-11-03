---
name: modszertan
description: Select or change the repo's leading development methodology (GSD vs superpowers vs neither). Use it when the user says "modszertan", "methodology", "which one do we use", "let's switch to GSD", "don't do the .planning thing", or when the SessionStart hook reported that there is no decision yet in this repo.
---

# Setting the leading methodology for this repo

GSD and superpowers cover the same ground — plan, execution, code review,
debug, verification. If both are installed, for the same task I would sometimes pick one,
sometimes the other. This decision is made **per repo**, and lives in the
`<repo>/.claude/METHODOLOGY` file.

## What to do

1. Check whether `.claude/METHODOLOGY` already exists and what is in it.
2. If the user said in the argument what they want, write that in. If not, **ask once**,
   briefly — using the table below to help the choice.
3. Write the answer as a single word into the `<repo>/.claude/METHODOLOGY` file:
   `gsd` · `superpowers` · `none`
4. Confirm in one sentence, and note that it takes effect from the next session start.

## Decision aid

| This repo… | Choose |
|---|---|
| long work split into several phases; needs a roadmap, phases, a `.planning/` trail, UAT | **gsd** |
| daily development, bugfixes, features; needs TDD discipline, systematic debug, sub-agent patterns, worktree isolation | **superpowers** |
| small repo, config, script, documentation; the ceremony is just an obstacle | **none** |

If the user is unsure: **superpowers** is the good default — less ceremony,
and switchable at any time. GSD is worth turning on when you really need the phase trail.

## What the system does after the setting

The plugin's SessionStart hook (`methodology-guard.sh`) reads the file at the start of every
session and puts it into the context, telling you which skill family to use and which to avoid.
The non-conflicting superpowers skills (`using-git-worktrees`, `dispatching-parallel-agents`,
`test-driven-development`) can be used in GSD mode too.

**Git is not required.** The marker works in any directory — in a company project, a notes
directory, an ad-hoc directory too. In a git repo the hook also asks about it if there is no
decision yet; in a non-git directory it stays silent until you place the marker yourself.

`.claude/METHODOLOGY` can be versioned — if the rest of the team also uses Claude Code,
commit it; if only you need it, put it into `.gitignore`.
