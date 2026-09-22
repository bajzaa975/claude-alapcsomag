SAVER LEVEL L2 (glm, balanced). `worker --level 1` = light, `--level 3` = tight, `--level 0` = all Claude.
FLASH RUNG (glm-5.3-flash): locate/map, tests/lint/build/shellcheck, read a file > 300 lines (summary only).
  Dispatch = Bash:  glm -p --model haiku "<full task text>"
GLM RUNG (glm-5.3): documents > 100 lines, implement a specified slice / TDD, fix review findings round 1.
  Dispatch = Bash:  glm -p "<full task text>"   (add --output-format json when you need usage;
  run_in_background for anything over ~1 minute). Flash NEVER writes code.
The worker cannot see this session: give it the repo path, file paths, acceptance criteria and the
<=40-line report contract in the prompt.
If no day-run routing table is in your context, everything not listed here stays on your session's model.
UNCHANGED, still Anthropic exactly as in the table: risk-bearing slices (opus), debugging (opus),
every review (Opus 5), and all ORCHESTRATOR-ONLY work.
ESCALATION LADDER for the GLM-rung classes becomes: glm r1 -> sonnet r2 -> opus r3 -> ORCH r4 -> park. Risk-bearing slices still start at opus.
PEAK: if `glm` exits 75 (Z.ai peak window), do that task on the Claude model the day-run table names
(flash classes -> haiku, glm classes -> sonnet); do not retry GLM until the window closes.
Dispatch first line: model: glm -- saver mode.   DAY-RUN.log: model=glm.
CLOSING REPORT: run `worker --usage <session start ISO>` and paste its last two lines.
