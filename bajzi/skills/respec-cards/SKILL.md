---
name: respec-cards
description: Use when the owner wants a system specified (or re-specified) in their own words as approval cards — "spec cards", "re-spec", "interview me about X", a new project idea before any code, or an existing project whose plan, code and owner intent have drifted apart.
disable-model-invocation: true
---

# Re-spec cards

## Overview
The owner-approved card is the yardstick; old plans and code are only SOURCES for questions. A card is a
short list of rules in the owner's words, each with an ID and a proof demo. No development starts in an
area without a locked card.

## Modes (pick by an observable fact)
- **No code yet** (new project; offer this BEFORE brainstorming/writing-plans): cards come from the idea.
  Rules have only "Owner wants" + "Proof"; the proof demo is the acceptance criterion.
- **Code exists** (retrofit): every card first gets a prep note (worker, see `prep-prompt.md`), then the
  interview; rules carry all four lines.

## Card map ("star") — fix it with the owner first
- **Nodes** (~12-15 core concepts: product, customer, subscription, invoice, user/permission…): one card each —
  what it is, its data, rules, who may change it, its states. Discussed once, referenced everywhere else.
- **Paths** (~8-10 end-to-end stories, e.g. "life of an order", "month-end close"): where dependencies surface.
- **Global rules** (~5: security, SSO/design, logging, backup, monitoring).
Card numbers are fixed once assigned; rule IDs are `<letter>-<nn>` per card (H-07), never reused.

## Files (per card NN)
| File | Content |
|---|---|
| `prep-NN-<slug>.md` | §0 Already decided (NOT asked) · §1 Agreed/implemented rules with source:line + code status · §2 Open points/contradictions · §3 Questions |
| `answers-NN.md` (answers; a project that already uses another answers-file name keeps it) | one `## NN/Qk <title>` block per answer — owner's words verbatim, then `Interpretation (<assistant>):` when not literal, then CONSEQUENCE/follow-ups; last line `## CARD NN CLOSED (<date>) — Q1–Qk answered, NEVER RE-ASK` |
| `NN-<slug>.md` (the card) | header (status, interview date, legal sources, rules referenced from other cards) + rule blocks |

## Before EVERY question
Grep all answers files, the decision log, legal research and earlier cards for the topic. Settled → it moves
to §0 with its source; do not ask it. A prior answer that the question contradicts → ask about the
contradiction, citing the answer.

## Question contract (in the owner's language; everything else in English)
Each question you send has exactly these parts, in order:
1. `NN/Qk — ` + the prep's own question ID (never renumber) + one decision in plain business language, no table/column names.
2. Today's fact in one line ("Today: …" — from code or the plan, with what you verified).
3. Options (a)(b)(c); the recommended one FIRST and marked "(Recommended)" in the owner's language.
4. `Why:` one line for the recommendation.
Every label above ("Today", "Recommended", "Why") is written in the owner's language too.
Name actors by name ("<maintainer> merges", "<owner> approves"), never "you/I". One decision per question;
batches of up to 4 only via the question tool, which shows them one at a time.
Legal points are NOT questions: read the statute text (not memory), decide, cite it (law + §), and state the
decision in the card. Never produce a lawyer question list.

## Recording an answer — immediately, before the next question
Verbatim owner words; your interpretation as a separate line when the answer is not literally an option;
consequences for code already built or other cards as a `CONSEQUENCE:` line (and in the handoff).

## The card — rule block
```
**H-07 <short rule name>**
- **<Owner> wants:** owner's words.
- **Old plan:** matches / differs — how.            (retrofit only)
- **Implemented (preliminary):** yes / partly / no — plain words + file:line.   (retrofit only)
- **Proof:** the sandbox demo that shows it (implemented: watch now; else: the dev task's acceptance test).
```
Header line: `> Status: draft | LOCKED (<owner> approved, <date>) | compared with code`. Locked = changes
only as dated amendments. Done for a rule = the owner saw its Proof demo. Every dev task/PR names its rule IDs;
review measures against the card text.

## Grilled marker
When cards NN..MM are LOCKED, put `Grilled: respec-cards <YYYY-MM-DD> (cards NN-MM)` in the header of the spec or plan those cards govern (no such file: the cards folder's README.md); replace an older `Grilled: respec-cards` line. `Grilled:` header lines and `## CARD NN CLOSED (<date>) ... NEVER RE-ASK` lines are the machine-checked "already grilled" markers, so their format must not change.

## Common mistakes
| Mistake | Fix |
|---|---|
| Question without recommendation/why | the contract above — parts 3 and 4 are mandatory |
| Renumbering questions in the message | keep `NN/Qk` from the prep everywhere |
| Re-asking something settled in another card's answers | grep before EVERY question; §0 |
| "Ask a lawyer" option | decide with citations |
| Feature-per-card split | node / path / global-rule cards |
| Card without rule IDs or Proof | rule block above |
