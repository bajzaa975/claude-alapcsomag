#!/usr/bin/env bash
# SessionStart hook — betölti a runtime/HANDOFF.md-t /clear, /compact és resume után.
#
# Két dolgot ad:
#   1. systemMessage      -> a FELHASZNÁLÓNAK jelenik meg a terminálon (ebben van a
#                            javasolt kezdő prompt, másolható/szerkeszthető)
#   2. additionalContext  -> a MODELL kontextusába kerül (a teljes HANDOFF.md)
#
# A beviteli mező (prompt input) automatikus kitöltése a Claude Code-ban NEM támogatott
# (nincs ilyen hook-kimeneti mező), ezért a javasolt prompt megjelenítés + másolás.
#
# FÜGGŐSÉGMENTES: nem kell hozzá jq, python vagy node — csak bash, sed, awk, tr.

set -uo pipefail

input=$(cat 2>/dev/null || true)

cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

f="$cwd/runtime/HANDOFF.md"
if [ ! -f "$f" ]; then
    printf '{}'
    exit 0
fi

# JSON string-escape: control-karakterek ki, \ és " escape-elve, sorvégek \n-re.
json_escape() {
    tr '\t' ' ' \
        | tr -d '\000-\010\013\014\016-\037' \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        | awk '{ printf "%s\\n", $0 }'
}

# A "## JAVASOLT KEZDŐ PROMPT" szekcióban lévő első kódblokk tartalma.
prompt=$(awk '
    /^## JAVASOLT KEZDŐ PROMPT/ { flag=1; next }
    flag && /^```/             { c++; if (c == 2) exit; next }
    flag && c == 1             { print }
' "$f" 2>/dev/null)

sep="────────────────────────────────────────────────────────────"

if [ -n "$prompt" ]; then
    msg=$(printf 'HANDOFF betöltve: %s\n\nJAVASOLT KEZDŐ PROMPT — másold be, vagy szerkeszd:\n%s\n%s\n%s' \
        "$f" "$sep" "$prompt" "$sep")
else
    msg=$(printf 'HANDOFF betöltve: %s\n(Nincs benne "## JAVASOLT KEZDŐ PROMPT" szekció — futtass /bajzi:handoff-ot a legközelebbi lezáráskor.)' "$f")
fi

msg_json=$(printf '%s' "$msg" | json_escape)
ctx_json=$(printf 'A runtime/HANDOFF.md tartalma (előző session átadója) — ebből folytasd, NE olvasd újra az egész repót:\n\n%s' "$(cat "$f")" | json_escape)

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
    "$msg_json" "$ctx_json"
