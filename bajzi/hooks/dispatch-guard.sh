#!/usr/bin/env bash
# PreToolUse(Agent|Task) hook -- refuses sub-agent dispatches whose brief breaks
# the DISPATCH BRIEF rule in skills/mode/DAY-RUN-RULES.md. Rules text alone did
# not hold (a 6-file review went out without code-review-graph; a two-finding
# fix round was told to "read the brief, the report and the whole review"), so
# the integrity check lives here.
#
# GATE: the same resolver as day-run-mode.sh and routing-counter.sh
# (lib-saver-level.sh): active only when SAVER_GATE_OPEN=yes (day-run on, OR
# CC_WORKER_MODE set, OR a non-Anthropic provider). Gate closed -> {} and
# nothing is written.
#
# A DISCIPLINE GUARD, NOT A SECURITY BOUNDARY: empty or unparseable stdin, a
# missing lib, anything unexpected -> {} (allow), exit 0. A broken hook must
# never wedge every dispatch.
#
# CLASSIFICATION, case-insensitive, over HEAD = description + the first 600
# bytes of the prompt (bytes, not characters: the script runs under LC_ALL=C so
# no locale can make it crash; for ASCII the two are the same), with every
# whitespace-delimited token containing ".md" removed first -- a file name
# (task-B3-review.md) is a reference, not the dispatch's intent:
#   FIX_OR_REREVIEW  HEAD matches fix round|fix r[0-9]|re-review|rereview|
#                    scoped review|delta review|review round [2-9]|findings to fix
#   REVIEW           HEAD has a word starting with "review", or subagent_type
#                    contains "review"
#   OTHER            everything else
# RULES (first match wins, in this order):
#   R1  REVIEW, and FIX_OR_REREVIEW when it is a re-review (HEAD or
#       subagent_type contains "review"): deny unless the FULL prompt carries a
#       graph marker (code-review-graph, detect-changes, detect_changes_tool,
#       get_review_context_tool, or a graph-*.json path) or the opt-out line
#       'GRAPH: n/a single-file <path>'. A plain fix round is exempt.
#   R2  FIX_OR_REREVIEW: deny if the prompt points at a full brief or review
#       file: a path matching -brief.md or -review*.md / -rereview*.md /
#       -re-review*.md. A -report.md path is fine (the fixer appends there).
#   R3  FIX_OR_REREVIEW: deny if the prompt is over 6000 characters.
#   R4  every dispatch with the gate open appends one line to
#       <cwd>/runtime/dispatch-sizes.log:
#       <ISO-UTC>\t<class>\t<subagent_type>\t<prompt chars>\t<allow|deny:R1|R2|R3>
#       A failed log write never changes the decision.
# Prompt chars = UTF-8 characters of the decoded prompt (a \uXXXX escape counts
# as one), counted by dropping continuation bytes, so the locale does not matter.
# The payload's newlines are flattened to spaces by json_fields, so the opt-out
# "line" is matched as the marker preceded by start-of-prompt or whitespace.
#
# Output: {} to allow, or exactly
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
#    "permissionDecisionReason":"dispatch-guard R<n>: <fix instruction>"}}
# and exit 0 either way.
#
# DEPENDENCY-FREE: bash, awk, sed, tr, head, wc, date.

set -uo pipefail
export LC_ALL=C

allow() { printf '{}'; exit 0; }

input=$(cat 2>/dev/null || true)
[ -n "$input" ] || allow

hookdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || allow
# shellcheck source=lib-json-fields.sh
. "$hookdir/lib-json-fields.sh" 2>/dev/null || allow
# shellcheck source=lib-saver-level.sh
. "$hookdir/lib-saver-level.sh" 2>/dev/null || allow

fields=$(printf '%s' "$input" | json_fields _complete cwd description subagent_type prompt)
ok="" cwd="" desc="" sub="" prompt=""
{ IFS= read -r ok; IFS= read -r cwd; IFS= read -r desc; IFS= read -r sub; IFS= read -r prompt; } <<< "$fields" || true
# A truncated/unparseable payload, or nothing recognisable under tool_input, is a
# parse failure: allow, write nothing.
[ "$ok" = "1" ] && [ -n "$desc$sub$prompt" ] || allow
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

saver_resolve "$cwd" 2>/dev/null || allow
[ "$SAVER_GATE_OPEN" = "yes" ] || allow

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# File names are not intent: "see task-B3-review.md" does not make an implement
# task a review, nor a fix round a re-review. Drop *.md tokens before classifying.
head_lc=$(lc "$desc ${prompt:0:600}" | sed -E 's/[^ ]*\.md/ /g')
sub_lc=$(lc "$sub")
prompt_lc=$(lc "$prompt")
chars=$(printf '%s' "$prompt" | tr -d '\200-\277' | wc -c | tr -cd '0-9')
[ -n "$chars" ] || chars=0

FIX_RE='fix round|fix r[0-9]|re-review|rereview|scoped review|delta review|review round [2-9]|findings to fix'
REVIEW_RE='(^|[^a-z0-9_])review'
GRAPH_RE='code-review-graph|detect-changes|detect_changes_tool|get_review_context_tool|graph-[^ ]*\.json'
OPTOUT_RE='(^|[[:space:]])GRAPH: n/a single-file [^[:space:]]'
FULLDOC_RE='-brief\.md|-(re-?)?review[^ /]*\.md'

class="OTHER"
if [[ "$head_lc" =~ $FIX_RE ]]; then
    class="FIX_OR_REREVIEW"
elif [[ "$head_lc" =~ $REVIEW_RE ]] || [[ "$sub_lc" == *review* ]]; then
    class="REVIEW"
fi

needs_graph="no"
case "$class" in
    REVIEW) needs_graph="yes" ;;
    FIX_OR_REREVIEW) { [[ "$head_lc" == *review* ]] || [[ "$sub_lc" == *review* ]]; } && needs_graph="yes" ;;
esac

decision="allow"
if [ "$needs_graph" = "yes" ] && ! [[ "$prompt_lc" =~ $GRAPH_RE ]] && ! [[ "$prompt" =~ $OPTOUT_RE ]]; then
    decision="deny:R1"
elif [ "$class" = "FIX_OR_REREVIEW" ] && [[ "$prompt_lc" =~ $FULLDOC_RE ]]; then
    decision="deny:R2"
elif [ "$class" = "FIX_OR_REREVIEW" ] && [ "$chars" -gt 6000 ]; then
    decision="deny:R3"
fi

# R4: log-safe subagent_type (names only), then one line; failure is ignored.
sub_log=$(printf '%s' "$sub" | tr -cd 'A-Za-z0-9._:-' | head -c 128)
[ -n "$sub_log" ] || sub_log="-"
{ mkdir -p "$cwd/runtime" \
    && printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$class" "$sub_log" "$chars" "$decision" \
        >> "$cwd/runtime/dispatch-sizes.log"; } 2>/dev/null || true

deny() {
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$1"
    exit 0
}
case "$decision" in
    deny:R1) deny "dispatch-guard R1: a review brief must carry code-review-graph output (detect-changes --brief or get_review_context_tool) or the line 'GRAPH: n/a single-file <path>'." ;;
    deny:R2) deny "dispatch-guard R2: a fix/re-review brief carries the finding, file:line, the code excerpt and the test command inline -- do not send the sub-agent to read the full brief or review file." ;;
    deny:R3) deny "dispatch-guard R3: fix/re-review brief over 6000 chars -- pass only the findings and the delta." ;;
esac
allow
