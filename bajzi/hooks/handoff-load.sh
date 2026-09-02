#!/usr/bin/env bash
# SessionStart hook — loads runtime/HANDOFF.md after /clear, /compact and resume.
#
# It provides two things:
#   1. systemMessage      -> shown to the USER in the terminal (this holds the
#                            suggested opening prompt, copyable/editable)
#   2. additionalContext  -> goes into the MODEL's context (the full HANDOFF.md)
#
# Automatically filling the prompt input in Claude Code is NOT supported
# (there is no such hook output field), hence the suggested prompt is displayed + copied.
#
# DEPENDENCY-FREE: needs no jq, python or node — only bash, sed, awk, tr.

set -uo pipefail

input=$(cat 2>/dev/null || true)

cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

f="$cwd/runtime/HANDOFF.md"
if [ ! -f "$f" ]; then
    printf '{}'
    exit 0
fi

# JSON string escape: control characters out, \ and " escaped, line ends to \n.
json_escape() {
    tr '\t' ' ' \
        | tr -d '\000-\010\013\014\016-\037' \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        | awk '{ printf "%s\\n", $0 }'
}

# The contents of the first code block in the "## SUGGESTED OPENING PROMPT" section.
prompt=$(awk '
    /^## SUGGESTED OPENING PROMPT/ { flag=1; next }
    /^## JAVASOLT KEZDŐ PROMPT/  { flag=1; next }   # legacy Hungarian heading
    flag && /^```/             { c++; if (c == 2) exit; next }
    flag && c == 1             { print }
' "$f" 2>/dev/null)

sep="────────────────────────────────────────────────────────────"

# The age of the HANDOFF. At startup an old handover can mislead, so we print it — but only if
# we can determine it. The stat flags are platform-dependent (GNU vs BSD), so we try both,
# and if neither works, the age is simply omitted from the message.
age_sfx=""
mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || printf '')
now=$(date +%s 2>/dev/null || printf '')
if [ -n "$mtime" ] && [ -n "$now" ] && [ "$mtime" -le "$now" ] 2>/dev/null; then
    age_h=$(( (now - mtime) / 3600 ))
    if [ "$age_h" -lt 24 ]; then
        age_sfx=" (updated ${age_h}h ago)"
    else
        age_sfx=" (updated $(( age_h / 24 )) days ago — check whether it is still current)"
    fi
fi

if [ -n "$prompt" ]; then
    msg=$(printf 'HANDOFF loaded: %s%s\n\nSUGGESTED OPENING PROMPT — paste it, or edit it:\n%s\n%s\n%s' \
        "$f" "$age_sfx" "$sep" "$prompt" "$sep")
else
    msg=$(printf 'HANDOFF loaded: %s%s\n(It has no "## SUGGESTED OPENING PROMPT" section — run /bajzi:handoff at the next close-out.)' "$f" "$age_sfx")
fi

msg_json=$(printf '%s' "$msg" | json_escape)
ctx_json=$(printf 'The contents of runtime/HANDOFF.md (the previous session handover) — continue from this, do NOT re-read the whole repo:\n\n%s' "$(cat "$f")" | json_escape)

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
    "$msg_json" "$ctx_json"
