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
2. **DECISION LOG:** record every substantive (non-trivial) decision IMMEDIATELY in
   `runtime/DECISIONS.md`, in this form:

   ```markdown
   ## [date time] <decision title>
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
   DECISIONS.md marked **BLOCKED**, and continue with the next task.
4. **STUCK RULE:** at most 3 fix attempts per error; after that the item is **PARKED**
   (state + what you tried into DECISIONS.md), and you move on. A parked item does not stop
   the whole run.
5. **CONTEXT DISCIPLINE:** per task/sprint, sub-agents do the heavy work; you update
   HANDOFF.md after every closed item. If context goes above ~40%: you do NOT start a new
   item — you close out the current one, write the closing report, and stop in a controlled way
   (listing the remaining items under "NOT STARTED").
6. **CLOSING REPORT:** at the end of the run write `runtime/AUTOPILOT-REPORT.md`: completed items
   (with test status), a summary of the decisions made on the user's behalf (referencing DECISIONS.md),
   PARKED and BLOCKED items, and a "LET'S REVIEW THIS TOGETHER" list in priority order.
   Give a terse extract of the same in the chat.

**Turning it off:** if the user writes at any point "autopilot off" — you immediately return to normal
(question-asking) mode, and briefly summarize where you are.
