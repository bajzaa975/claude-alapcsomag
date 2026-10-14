SAVER LEVEL L3 (tight). THIS SESSION RUNS ON GLM. No Anthropic model is reachable from it: every
"opus"/"sonnet"/"haiku" sub-agent you dispatch is served by GLM.
MODELS: this top-level session = glm_orchestrator_model (glm-5.3); every sub-agent and every `glm -p` dispatch = glm_model / glm_fast_model (both glm-5.3-flash today).
PRECEDENCE: at L3 this block OVERRIDES the day-run REVIEW LOOP and its "review a diff -> REVIEWER" and "final whole-branch review -> REVIEWER" rows. Queuing the review IS how those rows are met at L3; no sub-agent here is an Opus review, whatever model name it was given.
FLASH RUNG: locate/map, tests/lint/build/shellcheck, long-file summaries (summary only) -> glm -p --model haiku "<task>".
Everything else, including orchestration and implementation, runs here or via glm -p "<task>".
REVIEWS: do NOT dispatch review sub-agents, and never call anything a review. For every review the
work owes (each slice's Tier-1/Tier-2 review, the final whole-branch review), APPEND the evidence to
the queue file named in $SAVER_QUEUE_FILE (or, when unset, runtime/review-queue/<sprint>.md):
tier, the slice, changed files, the cited lines/functions, your own findings for Tier-2, gate result.
The runner owns the status: never write DONE for work whose review is queued; write BUILT.
The repo gate must still exit 0 before a slice is marked BUILT.
ESCALATION LADDER: glm r1 -> glm r2 -> append the slice to the queue file with status PARKED and move on. There is no Opus rung at L3.
PEAK: if `glm` exits 75 on a Claude session (the L3 mismatch line is above), dispatch the ORIGINAL Agent call again: the peak window is the counted Claude fallback. On a session that itself runs on GLM there is no Claude to fall back to: finish the current step only, write the handoff, mark the sprint BUILT (or PARKED), and stop.
Dispatch first line: model: glm -- saver L3.   DAY-RUN.log: model=glm.
After superpowers:writing-plans never ask the execution method; use superpowers:subagent-driven-development + the bajzi review loop.
