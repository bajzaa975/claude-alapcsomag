# Design grilling

## Trigger
Brainstorming's sizing step says "project" (a written spec/design). Not triggered: a quick clear task, a small
change agreed in chat, a bug fix or edit inside an already designed feature, a spec that already carries a
`Grilled:` line and has not changed since.

## Steps
1. Write the design.
2. Run `bajzi:grilling` on it: one question per round, through `ask_owner` where available.
3. Record each decision in the spec's `## Decisions` section.
4. Add the `Grilled: grilling <YYYY-MM-DD> (Q1-Qn)` header line (the format the grilling skill defines).
5. Only then report the design ready / ask for approval.

## Relation to "questions up front"
WHAT questions come before the design. For a project the grilling round is the one batch of HOW questions, so no
separate HOW batch follows it.

## Unattended runs
Night run, autopilot, `claude -p`: never grill. Open questions are written down and the item is parked.

## Day-run
Design and grilling are ORCH main-thread work; the day-run three-question limit covers execution, not design.
