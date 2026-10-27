---
name: autopilot
description: Autonomous work session — carrying several tasks or a sprint through without questions, with a decision log and a closing report. Use it when the user says "autopilot", "I'm not at the machine", "do it all without asking", "work through the list on your own".
---

# AUTOPILOT MODE

AUTOPILOT MODE ON. The scope and any extra instructions arrive in the argument (e.g.
"SPRINT-12..15" or "the next 3 items on the list"). If no scope is given, ask once in a
single sentence — after that you ask nothing more.

The user is not at the machine; from now on you work unsupervised. Rules:

1. **Do NOT ask, do not wait for approval.** Decide every question that comes up yourself based on
   the project documentation, the code's conventions and common sense — picking the least risky
   option that is easiest to reverse later.
2. **DECISION LOG:** at the start of the session run `node <this skill's dir>/decision-log.js` once (from the repo
   root). Write each substantive (non-trivial) decision when it is made into the handoff's `## Pending decisions` (untracked, no commit). Build ONE entry per sprint from that section and commit it
   at the sprint's end, to the path it printed (`runtime/DECISIONS.md` normally), in this form (the five lines
   repeat per decision inside the one entry). Commit it earlier only when the run stops before the sprint ends
   (context, PARKED, BLOCKED). Why: while an external orchestrator's night run holds the
   repo (`runtime/nightrun/.lock`), a session that is not the run's own (the run exports `BAJZI_NIGHT_RUN=1` to
   its own sessions) must not dirty a tracked file. If the helper cannot run (no node): use
   `runtime/DECISIONS.md` only if `runtime/nightrun/.lock` does not exist, else
   `runtime/handoff/autopilot-decisions.md`.

   ```markdown
   ## [date time] <sprint> -- decisions
   - Decision: <what you decided>
   - Alternatives: <what else was in play>
   - Why: <justification in 1-2 sentences>
   - Risk: low / medium / high
   - Affected: <files / sprint / module>
   ```

3. **FORBIDDEN ZONE — you may NOT decide these even in autopilot:** deploy/release/publish, force-push,
   rewriting git history, permanently deleting a branch/file, handling secrets/credentials in any way,
   modifying CI config (.github/), DB migration on live data, MAJOR version bump of a dependency,
   changing the task's original goal/scope. If you run into one of these: record it in
   the sprint's decision-log entry marked **BLOCKED** (written to `## Pending decisions` at once), and continue with the next task. When an owner answer would
   unpark it, the entry gets one line per blocked item `<n>. <question> -> recommended: <answer> (<why, <= 1 sentence>)`.
4. **STUCK RULE:** at most 3 fix attempts per error; after that the item is **PARKED**
   (state + what you tried into the decision log), and you move on. A parked item does not stop
   the whole run.
5. **CONTEXT DISCIPLINE:** per task/sprint, sub-agents do the heavy work; you rewrite the
   branch handoff file (`runtime/handoff/<branch-slug>.md`, see the handoff skill) after every slice commit,
   every review verdict, at ~40% context and before any stop or park. If context goes above ~40%: you do NOT start a new
   item — you close out the current one, write the closing report, and stop in a controlled way
   (listing the remaining items under "NOT STARTED").
6. **CLOSING REPORT:** at the end of the run write `runtime/AUTOPILOT-REPORT.md`: completed items
   (with test status), a summary of the decisions made on the user's behalf (referencing the decision log path),
   PARKED and BLOCKED items, the test gaps recorded in `runtime/findings/test-gaps.md` (listed for the owner,
   never fixed in the run), each sprint's closing lines from the review skill (`bajzi:review`) (the six time lines and the Tier 1 majors), and a "LET'S REVIEW THIS TOGETHER" list in priority order, numbered in the same
   `<n>. <question> -> recommended: <answer> (<why>)` format, all in ONE round: the owner's `yes`
   accepts every recommendation, `yes except <n>: <answer>` overrides single rows.
   Give a terse extract of the same in the chat.
   - If `~/.claude/worker-mode` is `glm` and `worker` is on PATH, run `worker --usage
     <session start ISO>` and include its last two lines under a "Token usage (GLM vs
     Anthropic)" heading; skip silently if the command is missing.

**Turning it off:** if the user writes at any point "autopilot off" — you immediately return to normal
(question-asking) mode, and briefly summarize where you are.
