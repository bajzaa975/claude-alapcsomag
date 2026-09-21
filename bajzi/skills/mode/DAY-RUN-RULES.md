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
- review a diff -> OPUS 5, ALWAYS. Never ORCH's model, never the implementer's model, never a
  cheaper tier because the diff "looks small". Fresh context every round; EVIDENCE line required
  or the verdict is FAIL.
- final whole-branch review -> OPUS 5, ALWAYS, on every development without exception. It does not
  matter what ORCH is or what wrote the code; the reviewer model is not a variable.
- debugging -> opus; ORCH takes it in the main thread after the third failed round
- design/planning/brainstorming -> ORCH, main thread, always
ESCALATION LADDER: sonnet r1 -> opus r2 -> ORCH r3 -> park. Climbs on the FIRST failure, not the
second. An identical blocking finding twice with no diff change parks immediately.
REVIEW LOOP -- this is how every development is done, no exceptions, however small it looks:
Each task ends with its own Opus 5 review giving TWO verdicts, spec compliance and quality. When
all tasks are done the branch gets a final Opus 5 whole-branch review. Findings go to a FIXER
sub-agent -- never the reviewer that raised them, never ORCH -- and the fix gets a NEW Opus 5
review round. Loop fix -> review -> fix -> review until it comes back clean. One-and-done is not
a review; a single fix wave is not a loop.
CLEAN = zero Critical AND zero Important findings AND the repo's own gate exits 0. Minor/cosmetic
findings are collected into a list handed to the owner, never looped on -- style nits regenerate
forever and would spin the loop without making the code safer.
NEVER report work as done before that loop terminates clean. "The tests pass" is not done. "The
implementer says it works" is not done. A clean review round plus a green gate is done.
Watch for tests that pass for the wrong reason: a test asserting only that *something* was
refused, when the code has several refusal paths, stays green after the security check is deleted.
A reviewer that cannot say WHICH path refused has not verified the test.
DIRECT-EDIT THRESHOLD -- all four required, else delegate:
<=20 changed lines, one file; no new logic; the file is already in context; not a forbidden zone
(deploy, secrets, CI config, migrations, history rewrite).
CONTEXT DISCIPLINE: sub-agent reports <=40 lines, paths and counts only, never file contents, raw
test output or diffs. Main thread never opens a file over 300 lines. At 40% context: finish the
slice, write the handoff, ask to clear. Parallel fixers own disjoint files, then one consistency
pass.
STARTUP INJECTIONS cost ORCH price too: keep SessionStart hook output small; memory plugin caps at 5 obs on owner machines (CLAUDE_MEM_CONTEXT_OBSERVATIONS=5).
FABLE DEPLETION: on the session-limit message, start nothing new, write the handoff, say "Fable
limit reached. Restart with Opus." Next session: claude --model claude-opus-5. Same rules reload;
ORCH is Opus; no rung spends Fable.
Every dispatch's first line: model: <name> -- <reason>.
Log every dispatch, one line, exact format, appended to runtime/DAY-RUN.log:
<ISO time> <task-class> model=<name> rounds=<n> result=<pass|fail|park|direct>
Allowed questions, only these three: scope change; forbidden zone; park-or-continue. Everything
else is decided and logged. Day-run never merges.
