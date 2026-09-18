DAY-RUN MODE -- /bajzi:mode normal turns this off.
ORCH = the model this session started with. Sub-agent tiers below are fixed regardless of ORCH.
ORCHESTRATOR-ONLY, never delegate: ask/brainstorm; design, spec, architecture; decomposition into
slices with disjoint file ownership and written acceptance criteria; judging verdicts (pass/fix/
park); the consistency pass after parallel fixers; edits meeting the direct-edit threshold below.
ROUTING TABLE, task class -> model:
- locate/map/"where is X" -> haiku; paths+line numbers only; retry once with sonnet; never main thread
- tests/lint/build/shellcheck -> haiku; pass/fail counts + first failing assertion only
- read a file > 300 lines -> haiku; summary only
- documents > 100 lines (handoffs, release notes) -> sonnet
- implement a specified slice / TDD -> sonnet, the default fixer
- risk-bearing slice (locks, concurrency, quotas, auth, money, migrations, destructive scripts, or
  3+ files) -> opus starting round 1, never sonnet
- fix review findings -> implementer's model, one rung up after a failed round; never the reviewer
- review a diff -> opus, always, fresh context every round; EVIDENCE line required or verdict is FAIL
- final review of risk-bearing logic -> ORCH, only when ORCH is Fable, one extra pass after opus
- debugging -> opus; ORCH takes it in the main thread after the third failed round
- design/planning/brainstorming -> ORCH, main thread, always
ESCALATION LADDER: sonnet r1 -> opus r2 -> ORCH r3 -> park. Climbs on the FIRST failure, not the
second. An identical blocking finding twice with no diff change parks immediately.
DIRECT-EDIT THRESHOLD -- all four required, else delegate:
<=20 changed lines, one file; no new logic; the file is already in context; not a forbidden zone
(deploy, secrets, CI config, migrations, history rewrite).
CONTEXT DISCIPLINE: sub-agent reports <=40 lines, paths and counts only, never file contents, raw
test output or diffs. Main thread never opens a file over 300 lines. At 40% context: finish the
slice, write the handoff, ask to clear. Parallel fixers own disjoint files, then one consistency
pass. One task per session.
STARTUP INJECTIONS cost ORCH price too: keep SessionStart hook output small; memory plugin caps at 5 obs on owner machines (CLAUDE_MEM_CONTEXT_OBSERVATIONS=5).
FABLE DEPLETION: on the session-limit message, start nothing new, write the handoff, say "Fable
limit reached. Restart with Opus." Next session: claude --model claude-opus-5. Same rules reload;
ORCH is Opus; no rung spends Fable.
Every dispatch's first line: model: <name> -- <reason>.
Log every dispatch, one line, exact format, appended to runtime/DAY-RUN.log:
<ISO time> <task-class> model=<name> rounds=<n> result=<pass|fail|park|direct>
Allowed questions, only these three: scope change; forbidden zone; park-or-continue. Everything
else is decided and logged. Day-run never merges.
