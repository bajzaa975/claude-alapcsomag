---
name: fix
description: Fix a round-1 findings file through the bajzi fixer agent (severity-blind copy), run the gate, commit, then run the round-2 re-review and STOP. Use it when the user says "/bajzi:fix <findings-file>", "fix the findings", or /bajzi:review round 1 returned findings.
---

# /bajzi:fix <runtime/findings/<slice-id>-r1.md>

Every fix goes through `bajzi:fixer`; you never fix the findings yourself. `FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"` (run from the repo root); the dispatch steps: `${CLAUDE_PLUGIN_ROOT}/skills/lib/dispatch.md`.

1. `FC copy fixer <findings-file>` — writes `<slice-id>-r1.fixer.md` (no severity, D4).
   Exit 3 = STOP: a round-2 file, or the slice already has its `-r2.md` (two rounds done); print
   the message, do nothing else. `CLEAN: nothing to fix` -> done.
2. `FC slice "<slice-id>"` for `files:` and `test:`. Remember `base` = the left side of the r1
   file's `range:` line (a full SHA).
3. Dispatch per dispatch.md, class `fix`, brief = the fixer brief on the `.fixer.md` file. A guard
   deny -> print the reason and its rule id, STOP. Save the final message to
   `runtime/findings/<slice-id>-r1.report.md`.
4. Run the `test:` command, unless it is `test: skip` (print "no test", run nothing; the gate in
   step 5 still runs). Red -> STOP and report; no commit, no round 2.
5. A path in `git status --porcelain --untracked-files=no` outside `files:` (ignore `runtime/**`,
   which the skills write) -> STOP and report; untracked files do not block, as in
   /bajzi:implement. Else `git add -- <each changed tracked file, and each files: path the fixer
   created>` (never `-A`), `git commit -m "<slice-id>: fix r1 findings"`. Where /bajzi:project-setup installed the bajzi
   gate (`.githooks/pre-commit`), the commit runs it on the staged files; a refused commit (non-zero
   exit) -> STOP and report, no round 2. Never `--no-verify`.
6. `tip=$(git rev-parse HEAD)`, then run `/bajzi:review <slice-id> <base>..<tip> --round 2`.
7. STOP. Round 2 is the last round this skill runs; whatever is still open is routed by the
   round-2 close (owner or debt). A round 3 is the owner's call, started by hand.

Any other `FC` or git exit code a step above does not name -> print its output and the exit code, STOP.
