#!/usr/bin/env bash
# SessionStart hook — loads the current TASK's handover after /clear, /compact and resume.
#
# Handovers live at runtime/handoff/<slug>.md, where <slug> is the sanitized git branch name
# ("default" outside a repo). The legacy single-file runtime/HANDOFF.md is still read, so no
# project breaks on upgrade.
#
# It provides two things:
#   1. systemMessage      -> shown to the USER in the terminal (this holds the
#                            suggested opening prompt, copyable/editable)
#   2. additionalContext  -> goes into the MODEL's context (the full handover)
#
# Automatically filling the prompt input in Claude Code is NOT supported
# (there is no such hook output field), hence the suggested prompt is displayed + copied.
#
# HARD RULE: never silently load a handover written for a DIFFERENT task. Loading the wrong one
# is the bug this file exists to prevent — when in doubt, list what is there and load nothing.
#
# DEPENDENCY-FREE: needs no jq, python or node — only bash, sed, awk, tr, cut, find, stat, date.
# git is consulted for the branch name, but EVERY failure (no repo, detached HEAD, "dubious
# ownership" on a root-owned repo, git not installed) falls back to the "default" slug.

set -uo pipefail

input=$(cat 2>/dev/null || true)

cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

hdir="$cwd/runtime/handoff"
legacy="$cwd/runtime/HANDOFF.md"

# ---------------------------------------------------------------------------- slug
# The current branch, sanitized. This derivation MUST stay byte-identical to the one in
# skills/handoff/SKILL.md — if the two drift, the skill writes files the hook cannot find.
# symbolic-ref, NOT `rev-parse --abbrev-ref HEAD`: rev-parse fails on a branch with no commits
# yet (unborn HEAD) and would silently send a fresh repo to the "default" slug. symbolic-ref
# resolves an unborn branch correctly and returns empty on detached HEAD, which is what we want.
branch=$(git -C "$cwd" symbolic-ref --quiet --short HEAD 2>/dev/null || printf '')
case "$branch" in
    ""|HEAD)
        slug="default"
        ;;
    *)
        slug=$(printf '%s' "$branch" \
            | tr '[:upper:]' '[:lower:]' \
            | sed -e 's/[^a-z0-9._-]/-/g' -e 's/--*/-/g' -e 's/^-*//' -e 's/-*$//' \
            | cut -c1-60 \
            | sed -e 's/-*$//')
        [ -z "$slug" ] && slug="default"
        ;;
esac

# ---------------------------------------------------------------------------- helpers
# JSON string escape: control characters out, \ and " escaped, line ends to \n.
json_escape() {
    tr '\t' ' ' \
        | tr -d '\000-\010\013\014\016-\037' \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        | awk '{ printf "%s\\n", $0 }'
}

# The stat flags are platform-dependent (GNU vs BSD), so we try both; empty if neither works.
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf ''; }

# The age of a handover. At startup an old handover can mislead, so we print it — but only if
# we can determine it; otherwise the age is simply omitted.
age_suffix() {
    local m n h
    m=$(mtime_of "$1")
    n=$(date +%s 2>/dev/null || printf '')
    if [ -z "$m" ] || [ -z "$n" ] || ! [ "$m" -le "$n" ] 2>/dev/null; then
        printf ''
        return
    fi
    h=$(( (n - m) / 3600 ))
    if [ "$h" -lt 24 ]; then
        printf ' (updated %sh ago)' "$h"
    else
        printf ' (updated %s days ago — check whether it is still current)' "$(( h / 24 ))"
    fi
}

# Terminal message only, no model context — used when we deliberately load nothing.
emit_msg_only() {
    printf '{"systemMessage":"%s"}' "$(printf '%s' "$1" | json_escape)"
    exit 0
}

sep="────────────────────────────────────────────────────────────"

# ---------------------------------------------------------------------------- resolution
# Order: this task's file -> legacy single file -> the lone recent sibling -> nothing.
f=""
note=""

if [ -f "$hdir/$slug.md" ]; then
    f="$hdir/$slug.md"
elif [ -f "$legacy" ]; then
    f="$legacy"
    note=$(printf '\nLegacy path — the next /bajzi:handoff migrates it to runtime/handoff/%s.md' "$slug")
else
    # Nothing for this task. Count what else is in runtime/handoff/ (glob, never `ls` parsing —
    # an unmatched glob stays literal and fails the -f test).
    cnt=0
    first=""
    for p in "$hdir"/*.md; do
        [ -f "$p" ] || continue
        cnt=$(( cnt + 1 ))
        [ -z "$first" ] && first="$p"
    done

    if [ "$cnt" -eq 0 ]; then
        printf '{}'
        exit 0
    fi

    if [ "$cnt" -eq 1 ]; then
        # The single-session case: one handover, recent, almost certainly meant for you.
        # Load it, but say loudly that it was written for a different task.
        cm=$(mtime_of "$first")
        now=$(date +%s 2>/dev/null || printf '')
        if [ -n "$cm" ] && [ -n "$now" ] && [ "$(( now - cm ))" -lt 86400 ] 2>/dev/null; then
            f="$first"
            note=$(printf '\nNOTE: this is the only handover present and it was written for task "%s", not for yours ("%s") — check that it still applies.' \
                "$(basename "$first" .md)" "$slug")
        else
            emit_msg_only "$(printf 'No handover for this task (%s).\nOne other exists but it is over a day old, so it was not loaded:\n  %s%s\nAsk me to load it if you want it.' \
                "$slug" "$(basename "$first")" "$(age_suffix "$first")")"
        fi
    else
        # Several tasks in flight. Loading any of them would be a guess — list and stop.
        list=""
        for p in "$hdir"/*.md; do
            [ -f "$p" ] || continue
            list="${list}  $(basename "$p")$(age_suffix "$p")
"
        done
        emit_msg_only "$(printf 'No handover for this task (%s). %s others exist — none loaded, so you do not resume the wrong task:\n%sAsk me to load one by name.' \
            "$slug" "$cnt" "$list")"
    fi
fi

# A sibling newer than the file we loaded means another session has moved past us.
warn=""
if [ -d "$hdir" ]; then
    newer=$(find "$hdir" -maxdepth 1 -name '*.md' -newer "$f" 2>/dev/null | head -3)
    if [ -n "$newer" ]; then
        names=$(printf '%s\n' "$newer" | while IFS= read -r p; do
            [ -n "$p" ] && printf '%s ' "$(basename "$p")"
        done)
        warn=$(printf '\nWARNING: newer handovers exist for other tasks: %s' "$names")
    fi
fi

# ---------------------------------------------------------------------------- output
# The contents of the first code block in the "## SUGGESTED OPENING PROMPT" section.
prompt=$(awk '
    /^## SUGGESTED OPENING PROMPT/ { flag=1; next }
    /^## JAVASOLT KEZDŐ PROMPT/  { flag=1; next }   # legacy Hungarian heading
    flag && /^```/             { c++; if (c == 2) exit; next }
    flag && c == 1             { print }
' "$f" 2>/dev/null)

age_sfx=$(age_suffix "$f")

if [ -n "$prompt" ]; then
    msg=$(printf 'HANDOFF loaded: %s%s%s%s\n\nSUGGESTED OPENING PROMPT — paste it, or edit it:\n%s\n%s\n%s' \
        "$f" "$age_sfx" "$note" "$warn" "$sep" "$prompt" "$sep")
else
    msg=$(printf 'HANDOFF loaded: %s%s%s%s\n(It has no "## SUGGESTED OPENING PROMPT" section — run /bajzi:handoff at the next close-out.)' \
        "$f" "$age_sfx" "$note" "$warn")
fi

msg_json=$(printf '%s' "$msg" | json_escape)
ctx_json=$(printf 'The contents of %s (the previous session handover for this task) — continue from this, do NOT re-read the whole repo:\n\n%s' \
    "$f" "$(cat "$f")" | json_escape)

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
    "$msg_json" "$ctx_json"
