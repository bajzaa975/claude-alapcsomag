SAVER MODE ON (worker-mode=glm). `worker --set claude` turns it off, `worker --set glm` back on.
GLM RUNG: these task classes go to a headless GLM worker instead of the Agent tool:
locate/map, tests/lint/build/shellcheck, read a file > 300 lines, documents > 100 lines,
implement a specified slice / TDD, fix review findings round 1.
Dispatch = Bash:  glm -p "<full task text>"   (add --output-format json when you need usage;
run_in_background for anything over ~1 minute). The worker cannot see this session: give it the
repo path, file paths, acceptance criteria and the <=40-line report contract in the prompt.
UNCHANGED, still Anthropic exactly as in the table: risk-bearing slices (opus), debugging (opus),
every review (Opus 5), and all ORCHESTRATOR-ONLY work.
ESCALATION LADDER becomes: glm r1 -> sonnet r2 -> opus r3 -> ORCH r4 -> park.
Dispatch first line: model: glm -- saver mode.   DAY-RUN.log: model=glm.
