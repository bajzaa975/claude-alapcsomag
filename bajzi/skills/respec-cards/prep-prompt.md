# Prep-note worker prompt (retrofit mode)

Dispatch one worker per card (cheap tier is fine; cards are independent → parallel). Fill the <…> slots.

```
You are preparing an owner-interview prep note for the <project> re-spec. Repo (read-only except the one
output file): <repo path>. Use Bash for all reads/searches; edit nothing except the output file.

Sources, in this order:
- Old plan: <plan docs; grep-only for any file > 300 lines>.
- Decisions: <decision log(s)>, <status docs>.
- Code: <schema dir>, <app/source dirs>, <scripts>.
- Answers and locked cards (do NOT re-ask what they settle; cite their rule IDs): <answers files>, <card files>.
- Format model: <an earlier prep note> (mirror its sections).

CARD <NN> — <name>: <topic list: data, states, rules, who changes it, integrations, legal angles>.
Output file: <path>/prep-<NN>-<slug>.md

Write the note in English, max ~120 lines:
## 0. Already decided (NOT asked again) — each with its source (answer/card ID/decision line).
## 1. Agreed / implemented rules — numbered, one plain-language rule per line, [source:line] and
   "CODE: yes / partly / missing (file:line)".
## 2. Open points / contradictions — where old plan, decisions and code disagree, or nothing exists.
## 3. Questions — 8-15, ONE decision each, most important first, numbered 1..k (these become NN/Qk); each with
   options, "Recommendation:" (concrete) and "Why:" (one line). Plain business language; no table/column names.
   Legal points are not questions: state the statute-based answer in §0 or §2 with the citation.
Mark anything unverified as UNCERTAIN. Never invent a file:line.

Final reply (<=15 lines, English): output path, line count, rule count per CODE status, top 3 questions.
```

After the worker: run the "Before EVERY question" grep yourself and move anything settled into §0 —
workers miss answers recorded after their sources were listed.
