---
name: debt
description: Parked review debt (runtime/findings/debt.md) - --check the cap before a slice, --drain it with one fixer pass plus one review at a milestone, --calibrate it with a blind reviewer re-rate. Use it when the user says "/bajzi:debt", "check the debt", "drain the debt", "calibrate the debt".
---

# /bajzi:debt --check | --drain | --calibrate

`FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"` (run from the repo root); the dispatch steps: `${CLAUDE_PLUGIN_ROOT}/skills/lib/dispatch.md`.
A dispatch the guard denies -> print the reason and its rule id, STOP (dispatch.md step 3).

**--check** — `FC check`. Exit 4 = `DEBT CAP HIT` (> 15 entries, or > 3 in one file, or an
unparseable `debt.md`): the next slice/sprint does not start. Print the output; that is all.

**--drain** (one pass, at a milestone review):
1. `FC copy fixer runtime/findings/debt.md` -> `debt.fixer.md`. `base=$(git rev-parse HEAD)`.
2. Dispatch class `drain-fix`: files = the files named in `debt.md`, test = the repo's test
   command (its project profile / CLAUDE.md; unknown -> ask the owner once). Save the report.
3. Gate as in /bajzi:fix steps 4-5 (the test command, then the commit runs the bajzi gate; red or
   refused -> STOP). Commit the changed files by path, `git commit -m "debt: drain"`.
4. `tip=$(git rev-parse HEAD)`; `FC brief review debt 2 <base>..<tip>` (it passes `debt.md` as the
   round-1 file); dispatch class `drain-review`. Save to `runtime/findings/debt-r2.md`,
   `FC validate` it (one retry, as /bajzi:review step 3).
5. `FC drain runtime/findings/debt-r2.md` — drops resolved entries; prints
   `drained <n>, remain <m>` and each remaining `if_unfixed` line. Print it verbatim. One pass only.

**--calibrate** (acceptance sprints only, D7):
1. `FC copy blind` -> `runtime/findings/debt.blind.md` (no severities).
2. `FC brief calibrate` (it carries the guard's single-file opt-out line), dispatch class
   `calibrate`. Save the reply to `runtime/findings/debt.rerate.txt`.
3. `FC calibrate runtime/findings/debt.rerate.txt` — writes `blind_severity` into `debt.md` and
   appends only the disagreements to `needs-owner.md` (`original: x · blind: y · <if_unfixed> ·
   your call`). Exit 2 (an id not re-rated, or rated twice) -> re-dispatch once, then STOP.

Any other `FC` or git exit code a step above does not name -> print its output and the exit code, STOP.
