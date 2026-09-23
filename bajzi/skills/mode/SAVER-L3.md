SAVER LEVEL L3 (tight). THIS SESSION RUNS ON GLM. No Anthropic model is reachable from it: every
"opus"/"sonnet"/"haiku" sub-agent you dispatch is served by GLM.
PRECEDENCE: at L3 this block OVERRIDES the day-run REVIEW LOOP and its "review a diff -> REVIEWER" and "final whole-branch review -> REVIEWER" rows. Queuing the review IS how those rows are met at L3; no sub-agent here is an Opus review, whatever model name it was given.
FLASH RUNG: locate/map, tests/lint/build/shellcheck, long-file summaries (summary only) -> glm -p --model haiku "<task>". Flash NEVER writes code.
Everything else, including orchestration and implementation, runs here or via glm -p "<task>".
REVIEWS: do NOT dispatch review sub-agents, and never call anything a review. For every review the
work owes (each slice's Tier-1/Tier-2 review, the final whole-branch review), APPEND the evidence to
the queue file named in $SAVER_QUEUE_FILE (or, when unset, runtime/review-queue/<sprint>.md):
tier, the slice, changed files, the cited lines/functions, your own findings for Tier-2, gate result.
The runner owns the status: never write DONE for work whose review is queued; write BUILT.
The repo gate must still exit 0 before a slice is marked BUILT.
ESCALATION LADDER: glm r1 -> glm r2 -> append the slice to the queue file with status PARKED and move on. There is no Opus rung at L3.
PEAK: if `glm` exits 75, finish the current step only, write the handoff, mark the sprint BUILT (or PARKED), and stop. There is no Claude fallback at L3.
Dispatch first line: model: glm -- saver L3.   DAY-RUN.log: model=glm.
