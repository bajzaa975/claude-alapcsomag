#!/usr/bin/env bash
# PreToolUse(Agent|Task) hook -- routes review and fix work through the bajzi
# agents (/bajzi:review -> bajzi:reviewer, /bajzi:fix -> bajzi:fixer) and keeps
# every brief small. Rules text alone did not hold (a 6-file review went out
# without code-review-graph; a fix round was told to "read the brief, the report
# and the whole review"), so the integrity check lives here.
#
# GATE: the same resolver as day-run-mode.sh and routing-counter.sh
# (lib-saver-level.sh): active only when SAVER_GATE_OPEN=yes (day-run on, OR
# CC_WORKER_MODE set, OR a non-Anthropic provider). Gate closed -> {} and
# nothing is written.
#
# A DISCIPLINE GUARD, NOT A SECURITY BOUNDARY: empty or unparseable stdin, a
# missing lib, anything unexpected -> {} (allow), exit 0. A broken hook must
# never wedge every dispatch. No <plugin root>/agents/ dir (an install without
# the bajzi agents) -> no rule applies, as there is no /bajzi:review to point
# at; the R4 line is still written.
#
# CLASSIFICATION by subagent_type FIRST (case-insensitive):
#   bajzi:reviewer -> REVIEWER, bajzi:fixer -> FIXER,
#   bajzi:implementer / bajzi:implementer-risk -> IMPLEMENTER.
# Any other (foreign) agent falls back to the prompt-text classes, first match
# wins (REREVIEW > FIX > REVIEW > OTHER). HEAD = the first 600 bytes of the
# prompt (bytes: the script runs under LC_ALL=C so no locale can crash it).
# Whitespace tokens containing ".md" are removed from description and HEAD
# first -- a file name is a reference, not the dispatch's intent. The prompt
# BODY never makes a dispatch a REVIEW.
#   REREVIEW  description matches re-?review|delta review|scoped review|
#             review round [2-9]
#   FIX       description or HEAD matches fix round|fix r[0-9]|findings to fix,
#             or the DESCRIPTION (only) matches the whole word
#             fix|address|apply|resolve ...up to 40 chars... finding(s)
#   REVIEW    description has the WORD review/reviews (code-review counts; not
#             reviewer, not self-review / self review), or subagent_type
#             contains "review"
#   OTHER     everything else
# RULES (first deny wins, in this order; plan §4.4 names them R1'/R2'):
#   R1  REVIEW, REREVIEW (a foreign agent): deny, "use /bajzi:review".
#       REVIEWER: allow only with a commit range ([0-9a-f]{7,}..[0-9a-f]{7,}) AND
#       a graph marker (code-review-graph, detect-changes, detect_changes_tool,
#       get_review_context_tool, or a graph-*.json path), or -- the calibrate
#       exemption -- NO range and the line
#       'GRAPH: n/a single-file <...>runtime/findings/<name>.blind.md'. A range
#       is a diff review, so the opt-out never covers one.
#   R2  every class but FIXER and REVIEWER: deny ("use /bajzi:fix") if the prompt
#       names a runtime/findings/*.md path or a *-review.md / *-rereview<n>.md /
#       *-re-review<n>.md file (a slice id like code-review-r1.md is neither).
#       FIXER: deny unless the prompt names exactly one distinct *.fixer.md
#       path. REVIEWER is exempt: it is read-only, and its round-2 brief names
#       the round-1 findings and the fixer report on purpose.
#   R3  every class but FIXER: deny if the prompt is over 24576 characters
#       (24 KB). The fixer's input is a .fixer.md the findings parser already
#       caps (40 findings / 24 KB).
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
# DEPENDENCY-FREE: bash, awk, sed, tr, grep, sort, head, wc, date.

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
RANGE_RE='(^|[^0-9a-z])[0-9a-f]{7,}\.\.[0-9a-f]{7,}([^0-9a-z]|$)'
CALIB_RE='(^|[[:space:]])graph: n/a single-file [^[:space:]]*runtime/findings/[^[:space:]/]+\.blind\.md([[:space:]]|$)'
# P = one path-token character. A path ends at anything but a word char, - or /
# (so "x.md." at a sentence end still counts, "code-review-r1.md" never does).
P="[^[:space:]\"'\`()<>]"
R2_RE="(runtime/findings/$P*\\.md|-(re-?)?review[0-9]*\\.md)([^a-z0-9_/-]|$)"
FIXER_RE="$P+\\.fixer\\.md"

case "$sub_lc" in
    bajzi:reviewer) class="REVIEWER" ;;
    bajzi:fixer) class="FIXER" ;;
    bajzi:implementer | bajzi:implementer-risk) class="IMPLEMENTER" ;;
    *)
        desc_lc=$(lc "$desc" | nomd)
        head_lc=$(lc "${prompt:0:600}" | nomd)
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
        fi ;;
esac

# Distinct *.fixer.md path tokens in the prompt.
fixer_paths() { printf '%s' "$prompt_lc" | grep -oE "$FIXER_RE" 2>/dev/null | sort -u | wc -l | tr -cd '0-9'; }

decision="allow" why=""
if [ -d "$hookdir/../agents" ]; then
    case "$class" in
        REVIEW | REREVIEW)
            decision="deny:R1"
            why="a review goes through /bajzi:review (subagent bajzi:reviewer), not a $class dispatch to '$sub'." ;;
        REVIEWER)
            if [[ "$prompt_lc" =~ $RANGE_RE ]]; then
                [[ "$prompt_lc" =~ $GRAPH_RE ]] || { decision="deny:R1"
                    why="a bajzi:reviewer brief with a range must carry code-review-graph output (FC brief review writes it)."; }
            elif ! [[ "$prompt_lc" =~ $CALIB_RE ]]; then
                decision="deny:R1"
                why="a bajzi:reviewer brief needs a <base>..<tip> commit range (FC brief review), or -- calibrate only -- 'GRAPH: n/a single-file runtime/findings/<x>.blind.md'."
            fi ;;
        FIXER)
            [ "$(fixer_paths)" = "1" ] || { decision="deny:R2"
                why="a bajzi:fixer brief names exactly one *.fixer.md path (FC copy fixer writes it)."; } ;;
        *)
            [[ "$prompt_lc" =~ $R2_RE ]] && { decision="deny:R2"
                why="findings and review files are fixed through /bajzi:fix (subagent bajzi:fixer) -- do not hand ${BASH_REMATCH[1]} to '$sub'."; } ;;
    esac
    if [ "$decision" = "allow" ] && [ "$class" != "FIXER" ] && [ "$chars" -gt 24576 ]; then
        decision="deny:R3"; why="brief over 24576 chars (24 KB) -- pass paths and the delta, not pasted history."
    fi
fi

# R4: log-safe subagent_type (names only), then one line; failure is ignored.
sub_log=$(printf '%s' "$sub" | tr -cd 'A-Za-z0-9._:-' | head -c 128)
[ -n "$sub_log" ] || sub_log="-"
{ mkdir -p "$cwd/runtime" \
    && printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$class" "$sub_log" "$chars" "$decision" \
        >> "$cwd/runtime/dispatch-sizes.log"; } 2>/dev/null || true

[ "$decision" = "allow" ] && allow
# The reason carries payload text ($sub, a path): a safe charset only, so no
# quote, backslash or control character can break the JSON.
reason=$(printf 'dispatch-guard %s: %s' "${decision#deny:}" "$why" | tr -cd "A-Za-z0-9 ._:/*<>()',;=-" | head -c 400)
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$reason"
exit 0
