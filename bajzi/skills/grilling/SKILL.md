---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round. Question numbers are global for the session: Q1..Qn continue across rounds and are never renumbered.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not implement anything until the user confirms you have reached a shared understanding. Writing decisions to the record file (below) is part of the interview, not "acting"; only implementation waits for the user's confirmation.

## Record as you go

After each round's answers and BEFORE the next round, write every settled decision to the record file. The record file is the `## Decisions` section of the spec or plan file being grilled (create the section if missing); with no such file, `runtime/handoff/<topic>.md` (create it; the branch handoff file `runtime/handoff/<branch-slug>.md` references it). Entry format, exactly:

```
- **Q<n> <title>:** <the decision, in the user's words>
  **Proof:** <one line: the observable check, demo or test that shows the decision holds>
```

A later answer that changes an earlier decision updates that entry (dated); it never adds a duplicate.

## End

When the frontier is empty and the user confirmed shared understanding, put the line `Grilled: grilling <YYYY-MM-DD> (Q1-Qn)` in the header of the spec or plan (directly under its title; replace an older `Grilled: grilling` line, keep any other `Grilled:` line), or at the top of the topic file.
