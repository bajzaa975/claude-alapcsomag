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

# A HANDOFF kora. Startup-nál egy régi átadó félrevihet, ezért kiírjuk — de csak ha
# meg tudjuk állapítani. A stat kapcsolói platformfüggők (GNU vs BSD), ezért mindkettőt
# megpróbáljuk, és ha egyik sem megy, a kor egyszerűen kimarad az üzenetből.
age_sfx=""
mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || printf '')
now=$(date +%s 2>/dev/null || printf '')
if [ -n "$mtime" ] && [ -n "$now" ] && [ "$mtime" -le "$now" ] 2>/dev/null; then
    age_h=$(( (now - mtime) / 3600 ))
    if [ "$age_h" -lt 24 ]; then
        age_sfx=" (${age_h} órája frissítve)"
    else
        age_sfx=" ($(( age_h / 24 )) napja frissítve — ellenőrizd, hogy még aktuális-e)"
    fi
fi

if [ -n "$prompt" ]; then
    msg=$(printf 'HANDOFF betöltve: %s%s\n\nJAVASOLT KEZDŐ PROMPT — másold be, vagy szerkeszd:\n%s\n%s\n%s' \
        "$f" "$age_sfx" "$sep" "$prompt" "$sep")
else
    msg=$(printf 'HANDOFF betöltve: %s%s\n(Nincs benne "## JAVASOLT KEZDŐ PROMPT" szekció — futtass /bajzi:handoff-ot a legközelebbi lezáráskor.)' "$f" "$age_sfx")
fi

msg_json=$(printf '%s' "$msg" | json_escape)
ctx_json=$(printf 'A runtime/HANDOFF.md tartalma (előző session átadója) — ebből folytasd, NE olvasd újra az egész repót:\n\n%s' "$(cat "$f")" | json_escape)

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
    "$msg_json" "$ctx_json"
