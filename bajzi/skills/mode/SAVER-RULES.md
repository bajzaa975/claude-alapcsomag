SAVER LEVEL L2 (glm, balanced). `worker --level 1` = light, `--level 3` = tight, `--level 0` = all Claude.
FLASH RUNG (glm_fast_model): locate/map, tests/lint/build/shellcheck, read a file > 300 lines (summary only).
  Dispatch = Bash:  glm -p --model haiku "<full task text>"
GLM RUNG (glm_model): documents > 100 lines, implement a specified slice / TDD, fix review findings round 1.
  Dispatch = Bash:  glm -p "<full task text>"   (add --output-format json when you need usage;
  run_in_background for anything over ~1 minute -- EXCEPT in a headless `claude -p` session, or
  when the result decides your last action: there wait in the foreground, or the turn ends and the
  task is killed before you act on it).
MODELS: a top-level GLM session = glm_orchestrator_model (glm-5.3); its sub-agents and every `glm -p`
dispatch (GLM rung and flash rung alike) = glm_model / glm_fast_model, today both glm-5.3-flash.
EVIDENCE (owner test 2026-10-03, hidden-test coding task): glm-5.3-flash matched Claude Sonnet on
quality (3/3 vs 3/3) but took ~10x longer (265 s vs 27 s): keep GLM dispatches FOREGROUND in a
headless session, and size night budgets for that.
The worker cannot see this session: give it the repo path, file paths, acceptance criteria and the
<=40-line report contract in the prompt.
If no day-run routing table is in your context, everything not listed here stays on your session's model.
UNCHANGED, still Anthropic exactly as in the table: risk-bearing slices (opus), every review
(REVIEWER, the reviewer allow-list), and all ORCH-ONLY work. Debugging stays opus here,
even with a repro (sonnet is only the r2 / peak fallback below, never a first-choice dispatch here).
ESCALATION LADDER for the GLM-rung classes becomes: glm r1 -> sonnet r2 -> opus r3 -> ORCH r4 -> park. Risk-bearing slices still start at opus.
PEAK: if `glm` exits 75 (Z.ai peak window), do that task on the Claude model the day-run table names
(flash classes -> haiku, glm classes -> sonnet); do not retry GLM until the window closes.
Dispatch first line: model: glm -- saver mode.   DAY-RUN.log: model=glm.
After superpowers:writing-plans never ask the execution method; use superpowers:subagent-driven-development + the bajzi review loop.
CLOSING REPORT: run `worker --usage <session start ISO>` and paste its last two lines.
