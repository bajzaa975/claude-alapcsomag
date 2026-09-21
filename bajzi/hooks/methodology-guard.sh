#!/usr/bin/env bash
# SessionStart hook — which development methodology leads in THIS repo?
#
# WHY. GSD and superpowers cover the same ground (plan -> execution -> review ->
# debug -> verification). If both are installed, the model picks sometimes one,
# sometimes the other for the same task. This hook records the decision per repo,
# and puts it into the context at the start of every session.
#
# Marker file:  <repo>/.claude/METHODOLOGY   — its content is a single word:
#   gsd          -> the gsd-* skills lead
#   superpowers  -> the superpowers skills lead
#   none         -> neither; plain work, do not force a methodology
#
# No marker file = the owner's global DEFAULT applies: superpowers. The hook
# never asks (standing decision, 2026-09-20); a marker file still overrides.
# In a non-git repo with no marker it stays silent.
#
# DEPENDENCY-FREE: bash, sed, awk, tr. It must never fail, never slow anything down.

set -uo pipefail

input=$(cat 2>/dev/null || true)
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

# The marker is ALWAYS respected — even without a git repo (company projects,
# notes directories, anything). But we only ask about it in a git repo, so that
# random directories stay quiet.
f="$cwd/.claude/METHODOLOGY"
if [ ! -f "$f" ] && [ ! -d "$cwd/.git" ]; then
    printf '{}'
    exit 0
fi

json_escape() {
    tr '\t' ' ' \
        | tr -d '\000-\010\013\014\016-\037' \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        | awk '{ printf "%s\\n", $0 }'
}

emit() { # $1 = systemMessage (may be empty), $2 = additionalContext
    local m c
    m=$(printf '%s' "$1" | json_escape)
    c=$(printf '%s' "$2" | json_escape)
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$m" "$c"
}

choice=""
[ -f "$f" ] && choice=$(head -1 "$f" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

case "$choice" in
  gsd)
    emit "" "METHODOLOGY in this repo: GSD. Do the planning/execution/review/debug work with the gsd-* skills (/gsd-plan-phase, /gsd-execute-phase, /gsd-code-review, /gsd-debug). Do NOT use the superpowers skills with the same purpose (brainstorming, writing-plans, executing-plans, systematic-debugging, requesting-code-review) or the claude-mem planning skills (make-plan, do) here — the other, non-conflicting superpowers skills (using-git-worktrees, dispatching-parallel-agents, test-driven-development) can be used. The user decided this once, do not ask again."
    ;;
  superpowers|sp)
    emit "" "METHODOLOGY in this repo: superpowers. Do the planning/execution/review/debug work with the superpowers skills (brainstorming, writing-plans, executing-plans, subagent-driven-development, systematic-debugging, requesting-code-review, verification-before-completion). Do NOT use the gsd-* skills or the claude-mem planning skills (make-plan, do) here, and do not create a .planning/ structure. The user decided this once, do not ask again."
    ;;
  none|nincs)
    emit "" "METHODOLOGY in this repo: neither. Do not start a GSD, superpowers or claude-mem make-plan/do process on your own; work directly, as the task requires. The user decided this once, do not ask again."
    ;;
  *)
    # No marker file. The owner's standing decision (2026-09-20) is that
    # superpowers is the DEFAULT everywhere, so this branch no longer asks and
    # no longer warns. An explicit marker still wins -- that is what the cases
    # above are for, including "none" when a repo really wants no methodology.
    emit "" "METHODOLOGY: this repo has no .claude/METHODOLOGY marker, so the owner's global default applies: superpowers. Do the planning/execution/review/debug work with the superpowers skills (brainstorming, writing-plans, executing-plans, subagent-driven-development, systematic-debugging, requesting-code-review, verification-before-completion). Do NOT use the gsd-* skills or the claude-mem planning skills (make-plan, do) here, and do not create a .planning/ structure. New work starts with planning, not code: brainstorm, then a written plan, then implementation. This is a STANDING decision -- do NOT ask the user which methodology to use, in this or any other repo."
    ;;
esac
