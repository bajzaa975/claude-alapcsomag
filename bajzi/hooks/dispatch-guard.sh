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
# CLASSIFICATION, case-insensitive, first match wins (REREVIEW > FIX > REVIEW >
# OTHER). HEAD = the first 600 bytes of the prompt (bytes: the script runs
# under LC_ALL=C so no locale can crash it). Whitespace tokens containing ".md"
# are removed from description and HEAD first -- a file name is a reference,
# not the dispatch's intent. The prompt BODY never makes a dispatch a REVIEW.
#   REREVIEW  description matches re-?review|delta review|scoped review|
#             review round [2-9]
#   FIX       description or HEAD matches fix round|fix r[0-9]|findings to fix,
#             or the DESCRIPTION (only) matches the whole word
#             fix|address|apply|resolve ...up to 40 chars... finding(s)
#   REVIEW    description has the WORD review/reviews (code-review counts; not
#             reviewer, not self-review / self review), or subagent_type
#             contains "review"
#   OTHER     everything else
# RULES (first deny wins, in this order):
#   R1  REVIEW, REREVIEW: deny unless the FULL prompt carries a graph marker
#       (code-review-graph, detect-changes, detect_changes_tool,
#       get_review_context_tool, or a graph-*.json path) or the opt-out line
#       'GRAPH: n/a single-file <path>'. FIX is exempt.
#   R2  FIX, REREVIEW: deny if the prompt sends the sub-agent to READ a full
#       brief or review file: any -brief.md path; a -review*.md /
#       -rereview*.md / -re-review*.md path unless it is a write target: the
#       text before the path token ends in a whole word write|append|save|output,
#       then (no "." in between) to|into|in, then only whitespace/quotes/backticks.
#       A -report.md path is fine (the fixer appends there).
#   R3  FIX, REREVIEW: deny if the prompt is over 6000 characters.
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
# File names are not intent ("per task-B3-review.md" is a reference): *.md
# tokens are dropped from the text that is classified.
nomd() { sed -E 's/[^ ]*\.md/ /g'; }
desc_lc=$(lc "$desc" | nomd)
head_lc=$(lc "${prompt:0:600}" | nomd)
sub_lc=$(lc "$sub")
prompt_lc=$(lc "$prompt")
chars=$(printf '%s' "$prompt" | tr -d '\200-\277' | wc -c | tr -cd '0-9')
[ -n "$chars" ] || chars=0

W='[^a-z0-9_]'   # a non-word character (ERE has no \b)
REREVIEW_RE='re-?review|delta review|scoped review|review round [2-9]'
FIX_HEAD_RE='fix round|fix r[0-9]|findings to fix'
FIX_DESC_RE="$FIX_HEAD_RE|(^|$W)(fix|address|apply|resolve)$W(.{0,40}$W)?findings?($W|$)"
# The WORD review/reviews (code-review counts), not reviewer; self-review and
# self review are removed from the description before this runs.
REVIEW_RE="(^|$W)reviews?($W|$)"
GRAPH_RE='code-review-graph|detect-changes|detect_changes_tool|get_review_context_tool|graph-[^ ]*\.json'
OPTOUT_RE='(^|[[:space:]])GRAPH: n/a single-file [^[:space:]]'
BRIEF_RE='-brief\.md'
REVFILE_RE='-(re-?)?review[^ /]*\.md'
# A write target: a whole write/append/save/output, then (no sentence break)
# to/into/in, then only whitespace, quotes or backticks up to the path token.
WRITE_RE="(^|$W)(write|append|save|output)$W([^.]*$W)?(to|into|in)[[:space:]\"'\`]*\$"

class="OTHER"
if [[ "$desc_lc" =~ $REREVIEW_RE ]]; then
    class="REREVIEW"
elif [[ "$desc_lc" =~ $FIX_DESC_RE ]] || [[ "$head_lc" =~ $FIX_HEAD_RE ]]; then
    class="FIX"
else
    d="${desc_lc//self-review/}"; d="${d//self review/}"
    if [[ "$d" =~ $REVIEW_RE ]] || [[ "$sub_lc" == *review* ]]; then
        class="REVIEW"
    fi
fi

# R2: does the prompt send the sub-agent to READ a full brief or review file?
# Any -brief.md does. A review-file path does unless the text before its path
# token ends in a write target (WRITE_RE: "write your verdict to <path>").
reads_full_doc() {
    [[ "$prompt_lc" =~ $BRIEF_RE ]] && return 0
    local rest="$prompt_lc" m pre
    while [[ "$rest" =~ $REVFILE_RE ]]; do
        m="${BASH_REMATCH[0]}"
        pre="${rest%%"$m"*}"
        pre="${pre%"${pre##*[ ]}"}"          # back to the start of the path token
        [[ "$pre" =~ $WRITE_RE ]] || return 0
        rest="${rest#*"$m"}"
    done
    return 1
}

decision="allow"
case "$class" in REVIEW | REREVIEW)
    if ! [[ "$prompt_lc" =~ $GRAPH_RE ]] && ! [[ "$prompt" =~ $OPTOUT_RE ]]; then
        decision="deny:R1"
    fi ;;
esac
case "$decision:$class" in allow:FIX | allow:REREVIEW)
    if reads_full_doc; then
        decision="deny:R2"
    elif [ "$chars" -gt 6000 ]; then
        decision="deny:R3"
    fi ;;
esac

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
