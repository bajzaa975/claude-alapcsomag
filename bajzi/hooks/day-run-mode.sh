#!/usr/bin/env bash
# SessionStart hook -- is this session running in "day-run" working mode?
#
# WHY. Day-run is an opt-in working mode: a fixed set of routing, dispatch and
# context rules that must be in the context from the very first turn, on every
# session start, including after a compaction (the block is gone after one).
# The rules live in ONE file, skills/mode/DAY-RUN-RULES.md, and this hook is the
# only thing that injects them.
#
# Mode file, first match wins:
#   <cwd>/runtime/bajzi-mode      project override
#   $HOME/.claude/bajzi-mode      user default
# Its content is a single word:
#   day-run  -> inject the rules block
#   anything else, a missing file, an unreadable file or an empty first line
#            -> print exactly {} and stay silent. A bare plugin install must
#               never reroute a stranger's session.
#
# COST. The injected block is paid at the orchestrator's price on EVERY session,
# so it is capped at 40 lines below, by the single head call on the rules file --
# a defensive cap that holds
# even if the rules file grows. This hook reads NOTHING besides the two mode
# files and the rules file.
#
# KEEP IN SYNC: the mode-file read below
#   head -1 "$f" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
# must stay BYTE-IDENTICAL to the read in skills/mode/SKILL.md. If the two
# drift, the skill and this hook disagree about the current mode.
#
# DEPENDENCY-FREE: bash, sed, awk, tr, head. It must never fail: every path
# exits 0 with valid JSON on stdout.

set -uo pipefail

input=$(cat 2>/dev/null || true)
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

# Env first, so a test run can point at a fake plugin root.
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

f=""
if [ -f "$cwd/runtime/bajzi-mode" ]; then
    f="$cwd/runtime/bajzi-mode"
elif [ -f "${HOME:-}/.claude/bajzi-mode" ]; then
    f="${HOME:-}/.claude/bajzi-mode"
fi
if [ -z "$f" ]; then
    printf '{}'
    exit 0
fi

mode=$(head -1 "$f" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
if [ "$mode" != "day-run" ]; then
    printf '{}'
    exit 0
fi

rules="$root/skills/mode/DAY-RUN-RULES.md"
block=""
[ -f "$rules" ] && block=$(head -40 "$rules" 2>/dev/null)
if [ -z "$block" ]; then
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

emit "day-run mode active ($f). /bajzi:mode normal to turn it off." "$block"
