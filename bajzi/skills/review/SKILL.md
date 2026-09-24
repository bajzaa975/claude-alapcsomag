---
name: review
description: Review a slice's commit range through the bajzi reviewer agent, write and validate the findings file, and on round 2 apply the close policy (owner / debt) and the debt cap. Use it when the user says "/bajzi:review <slice> <range>", "review slice <id>", or /bajzi:fix calls round 2.
---

# /bajzi:review <slice-id> <range> [--round 2 --previous <file>]

Every review goes through `bajzi:reviewer`; you never review the code yourself. `FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"` (repo root); the
dispatch steps: `${CLAUDE_PLUGIN_ROOT}/skills/lib/dispatch.md`. Round is 1 unless `--round 2`;
the skill has no other round.

1. Build the review brief (dispatch.md) from `git diff --name-only <range>` and `git diff <range>`.
   Round 2 adds `--previous` (the r1 file) and `runtime/findings/<slice-id>-r1.report.md`.
2. Dispatch per dispatch.md: class `review` (round 1) or `rereview` (round 2).
3. Save the reviewer's final message verbatim to `runtime/findings/<slice-id>-r<round>.md`
   (the reviewer has no write path), then `FC validate <that file>`.
   Exit 2 = the file breaks the format: re-dispatch ONCE with the error lines appended to the
   brief; still invalid -> STOP and report the errors. Never edit the findings yourself.
4. Print the validate line (verdict + open counts by severity).
5. Round 1: `CLEAN` -> done. Otherwise next step: `/bajzi:fix runtime/findings/<slice-id>-r1.md`.
6. Round 2: `FC close <slice-id>` applies D4 — open blocker/major and every ATTEMPTED,
   unaccounted or fix-introduced finding -> `runtime/findings/needs-owner.md`; open minor/nit the
   fixer marked OUT_OF_SLICE -> `runtime/findings/debt.md`. Print its output verbatim, including
   any `DEBT CAP HIT` line, then list the new `needs-owner.md` lines. STOP: there is no further
   round in the skill; a third round is the owner's call, started by hand.
