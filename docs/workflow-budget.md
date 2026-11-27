# Workflow advice and budget

How every session advises on the Claude Code Workflow tool (multi-agent workflow scripts) and keeps
one workflow from spending a week's quota. The Workflow tool's own rule still holds: it runs only
after the owner opts in with their own words. This rule never replaces that opt-in.

## 1. The advice line
**When:** at the start of a substantive task that could run as a workflow (executing a plan with two or
more slices, a review or audit, a migration or sweep, research), and whenever the owner asks for a
workflow. Not for quick tasks, questions or single edits.

**What:** ONE line, before acting:

`Workflow: recommended | not worth it -- <reason> -- ~<n> agents, ~<tokens> est. (<unit>)`

The estimate names its unit: `out` (output tokens, what `budget.spent()` counts) or `total` (all
sub-agent tokens, what the usage report shows). Example lines:
- `Workflow: not worth it -- three UI slices edit the same file, in order -- 3 plain sonnet dispatches`
- `Workflow: recommended -- auth + concurrency audit, 2 lenses, Critical-only verify -- ~5 agents, ~0.6M est. (total)`

**Recommend** a workflow when the work is genuinely parallel and independent (different files or
areas), a broad sweep or audit, a multi-lens review of Tier 1 code (auth, concurrency, money,
migrations), or too large for one context.

**Advise against** it, and name the cheaper path (plain Agent dispatches, or inline), when:
- the steps are sequential, or edit the same file;
- the task is a handful of tool calls, or one implementer slice;
- a re-review of a small fix diff is enough;
- weekly usage is high: the status line `7d` field (`seven_day_pct` in the status record) at 60% or
  more, when it is available.

If the owner asked for a workflow that is not worth it, the line says so and names the cheaper path;
the owner's explicit choice still wins.

**Owner channel:**
- "Not worth it" is an FYI: one chat line, then the cheaper path, no question.
- "Recommended" without an opt-in: ONE question, which also settles the ceiling. Under the orchestrator
  panel it goes through `ask_owner`, non-blocking. Options: plain agents (the default, and what
  `default_taken` always names), workflow with ceiling X, workflow with another ceiling. A default
  never opts in, because only the owner's own words do.
- The owner already opted in and typed a `+<N>k`/`+<N>M` budget: no question at all.
- Unattended runs (autopilot, night run, `claude -p`) launch a workflow only if their brief opted in.

## 2. Budget rules for a workflow that runs
1. **Say it first:** agent count, models and the estimate, in the advice line or just before the call.
2. **Hard ceiling in the script:** `budget.total` is set only by the owner's `+<N>k` directive; a ceiling
   given in a panel answer does not set it. The script therefore enforces its own cap:
   `const start = budget.spent(); const CAP = budget.total ?? <agreed ceiling>;` and before each
   `agent()` it checks `budget.spent() - start`. Over the cap, the label goes to `dropped` and no
   agent starts. `spent()` counts output tokens of the whole turn (the pool is shared with the main
   loop), so the delta is what counts.
3. **Size:** under the default "medium" guideline (fewer than 10 agents) unless the owner raised it.
   Anything cut to stay under it is listed in `dropped`, never capped silently.
4. **Reviewers:** at most 2 lenses for Tier 1 code, 1 for Tier 2/3. Adversarial verify only for
   Critical (blocker) findings, at most 1 checker each. Never one checker per Important (major) or
   Minor finding.
5. **Models:** the day-run routing table holds: tests and gates on haiku (or sonnet) at low effort,
   implementation and fixes on sonnet, every review lens and checker on the REVIEWER model (the
   REVIEWER MODELS line, else `reviewer_models`), never the provider that wrote the code, never a hardcoded model.
6. **Review loop untouched:** a workflow never replaces a sprint's `/bajzi:review` round or adds
   reviewers to it. Multi-lens review is for audits outside the loop. A workflow that drives slices
   runs the same per-slice chain as `docs/dev-process.md`.
7. **Report after:** the script returns `{agents, spent, dropped}`; the session reports the agent count
   and token use, and in day-run logs the task's usual DAY-RUN.log line with them in the result
   suffix, e.g. `result=pass(agents=5,out=0.3M)`.
