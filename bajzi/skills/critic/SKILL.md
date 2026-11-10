---
name: critic
description: Run the read-only plan critic on a final execution plan and triage its failure scenarios. Use it when the user says "/bajzi:critic <plan-stem>", or before executing an M/L plan.
---

# /bajzi:critic <plan-stem>

`FC` = `node "${CLAUDE_PLUGIN_ROOT}/lib/findings-cli.js"` (run from the repo root); dispatch steps: `${CLAUDE_PLUGIN_ROOT}/skills/lib/dispatch.md`.
Plan = `runtime/plans/<stem>.md` or `docs/superpowers/plans/<stem>.md`; slices = `runtime/slices/<stem>-t<N>.md`.

0. Size M or L only. `FC critic-ready "<stem>"` exit 0 -> print "already triaged", stop. S or XS repo (project-profile `size`) -> print "critic not needed", stop.
1. `FC critic-model` -> `<model>` (exit 2 = invalid `plan_critic_model`: print it, stop).
2. Brief (`runtime/briefs/<stem>-critic.txt`): the plan path, the slice paths, the stem. Dispatch per dispatch.md with
   `subagent_type: bajzi:plan-critic`, `model: <model>`, `effort: high`, description `critic <stem>`.
   The dispatch fails on the Fable session or usage limit -> re-dispatch once with `model: opus` and set the header line
   to `model: opus (fable limit)`; never stop for the limit.
3. Save the final message to `runtime/critic/<stem>.md` (a rerun overwrites it and drops any triage). `FC critic-check "<stem>"`
   exit 2 -> print the errors and re-dispatch once; still failing -> STOP and report.
4. Triage. Zero scenarios -> write `## Triage` with `auto: true`.
   - Attended: ONE `ask_owner` card listing every scenario (accept/reject each; default accept high, reject the rest).
   - Unattended: no card; write `auto: true`, accept the high scenarios, reject the rest, and list the auto-triaged plan
     and its accepted scenarios in the run report.
   Append `## Triage` to the file: `S1: accept` ... one line per scenario (plus `auto: true` when automatic). The owner may
   instead give a reason: write `skipped: <reason>` and nothing else.
5. For each accepted scenario append to its slice's `acceptance:` one concrete, testable item ending `(critic S<n>)`
   (the scenario's test as the check, one clause).
6. `FC critic-ready "<stem>"` must exit 0; print the accepted ids.
