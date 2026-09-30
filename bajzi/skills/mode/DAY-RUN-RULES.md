DAY-RUN MODE -- /bajzi:mode normal turns this off.
ORCH = the model this session started with. ORCH-ONLY, never delegate: ask/brainstorm; design, spec,
architecture; slice decomposition (disjoint files, written acceptance criteria); verdicts
(pass/fix/park); consistency pass after parallel fixers; direct edits below the threshold.
ROUTING TABLE, task class -> model:
- locate/map/"where is X" -> haiku; paths+lines only; retry once with sonnet; never main thread
- tests/lint/build/shellcheck -> haiku; pass/fail counts + first failing assertion only
- read a file > 300 lines -> haiku, summary only; documents > 100 lines (handoffs, notes) -> sonnet
- implement a specified slice / TDD -> sonnet, the default fixer
- risk-bearing slice (locks, concurrency, quotas, auth, money, migrations, destructive scripts) -> opus from round 1, never sonnet. File count alone is not risk: a 3+ file slice stays sonnet
- fix review findings -> implementer's model, one rung up after a failed round; never the reviewer
- review a diff / final whole-branch review -> REVIEWER, ALWAYS. Never ORCH's or the implementer's model, never a cheaper tier for a "small" diff. Fresh context each round; EVIDENCE line required or FAIL. REVIEWER = a model from the REVIEWER MODELS line after this block, else `reviewer_models` in ~/.claude/bajzi/config.json; never GLM.
- debugging -> sonnet when a failing test/repro exists (give it verbatim), climbing the LADDER; else opus (no repro), which climbs to ORCH next, never down to sonnet
- design/planning/brainstorming -> ORCH, main thread, always
ESCALATION LADDER: sonnet r1 -> fresh sonnet r2 (new sub-agent) -> opus r3 -> ORCH r4 -> park.
Climb on the FIRST failure. An identical blocking finding twice with no diff change parks at once.
REVIEW LOOP, every development: implement -> REVIEWER review -> FIXER (never the reviewer, never
ORCH) -> NEW review, until CLEAN; then a final REVIEWER whole-branch review. One fix wave is not a
loop. Use /bajzi:review and /bajzi:fix; dispatch-guard enforces briefs and names the rule (R1-R3).
CLEAN = zero Critical AND zero Important findings AND the repo's own gate exits 0. Minor findings go
to the owner as a list, never looped on.
Never report done before the loop ends clean; "tests pass" is not done. Beware tests that pass for the wrong reason: asserting only that *something* was refused stays green
after the security check is deleted. A reviewer must say WHICH path refused.
DIRECT-EDIT THRESHOLD, all four or delegate: <=20 changed lines, one file; no new logic; file already
in context; not a forbidden zone (deploy, secrets, CI config, migrations, history rewrite).
CONTEXT: sub-agent reports <=40 lines, paths and counts only. Main thread never opens a file over 300
lines. At 40% context: finish the slice, write the handoff, ask to clear.
FABLE DEPLETION: on the session-limit message, start nothing new, write the handoff, say "Fable
limit reached. Restart with <X>." X = the first REVIEWER MODELS id that is not a Fable model, else
Opus. Next session: claude --model <X>.
Every dispatch's first line: model: <name> -- <reason>. Log every dispatch, one line, exact format,
appended to runtime/DAY-RUN.log:
<ISO time> <task-class> model=<name> rounds=<n> result=<pass|fail|park|direct>
Allowed questions, only these three: scope change; forbidden zone; park-or-continue. Everything
else is decided and logged. Day-run never merges.
After superpowers:writing-plans never ask the execution method; execute per this mode.
## Owner tasks -- do it yourself
Default: you do it, no approval line. An owner step must name its rung:
1. Permission-gated (~/.claude, settings, deploy/release, secrets, git history, another repo's commit, anything auto-mode blocks) -> still yours: one approval line, then you run it.
2. Impossible even with approval (elevation, login, UI, no tool there) -> scripts/owner/<name>.ps1|.sh, idempotent; owner runs one command.
3. Not scriptable (physical, wizard, owner judgment) -> numbered steps.
"Who" in a plan or table is "me" unless rung 2/3.
