SAVER LEVEL L1 (light). `worker --level 0` = all Claude, `--level 2` = balanced, `--level 3` = tight.
FLASH RUNG: these task classes go to the GLM fast model (glm-5.3-flash) instead of haiku:
locate/map, tests/lint/build/shellcheck, read a file > 300 lines (summary only).
Dispatch = Bash:  glm -p --model haiku "<full task text>"   (run_in_background for anything over ~1 minute -- EXCEPT in a headless `claude -p` session or when the result decides your last action: wait in the foreground, or the turn ends and the task is killed).
The worker cannot see this session: give it the repo path, file paths, acceptance criteria and the
<=40-line report contract in the prompt. Flash NEVER writes code.
If no day-run routing table is in your context, everything not listed here stays on your session's model.
UNCHANGED, on Claude exactly as in the table: implement/fix (sonnet), risk-bearing slices (opus),
debugging (opus), every review (REVIEWER, the reviewer allow-list), all ORCHESTRATOR-ONLY work.
PEAK: if `glm` exits 75 (Z.ai peak window), do that task on haiku instead; do not retry GLM until the window closes.
Dispatch first line: model: glm-flash -- saver L1.   DAY-RUN.log: model=glm-flash.
CLOSING REPORT: run `worker --usage <session start ISO>` and paste its last two lines.
