SAVER LEVEL L3 (tight). THIS SESSION RUNS ON GLM. No Anthropic model is reachable from it: every
"opus"/"sonnet"/"haiku" sub-agent you dispatch is served by GLM.
FLASH RUNG: locate/map, tests/lint/build, long-file summaries -> glm -p --model haiku "<task>".
Everything else, including orchestration and implementation, runs here or via glm -p "<task>".
REVIEWS: do NOT dispatch review sub-agents, and never call anything a review. For every review the
work owes (each slice's Tier-1/Tier-2 review, the final whole-branch review), APPEND the evidence to
the queue file named in $SAVER_QUEUE_FILE (or, when unset, runtime/review-queue/<sprint>.md):
tier, the slice, changed files, the cited lines/functions, your own findings for Tier-2, gate result.
The runner owns the status: never write DONE for work whose review is queued; write BUILT.
ESCALATION LADDER: glm r1 -> glm r2 -> queue it. There is no Opus rung at L3.
PEAK: if `glm` exits 75, stop starting GLM work and finish the current step only.
Dispatch first line: model: glm -- saver L3.   DAY-RUN.log: model=glm.
