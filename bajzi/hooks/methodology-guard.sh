#!/usr/bin/env bash
# SessionStart hook — melyik fejlesztési módszertan a vezető EBBEN a repóban?
#
# MIÉRT. A GSD és a superpowers ugyanazt fedi (terv -> végrehajtás -> review ->
# debug -> verifikáció). Ha mindkettő fent van, a modell hol az egyiket, hol a
# másikat választja ugyanarra a feladatra. Ez a hook repónként rögzíti a döntést,
# és minden session elején beteszi a kontextusba.
#
# Jelölőfájl:  <repo>/.claude/METHODOLOGY   — tartalma egyetlen szó:
#   gsd          -> a gsd-* skillek vezetnek
#   superpowers  -> a superpowers skilljei vezetnek
#   none         -> egyik sem; sima munka, ne erőltess módszertant
#
# Nincs jelölőfájl + git-repó = a hook megkéri a modellt, hogy EGYSZER kérdezze meg.
# Nem git-repóban néma marad.
#
# FÜGGŐSÉGMENTES: bash, sed, awk, tr. Soha nem bukhat el, soha nem lassíthat.

set -uo pipefail

input=$(cat 2>/dev/null || true)
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

# Csak projektben van értelme.
[ -d "$cwd/.git" ] || { printf '{}'; exit 0; }

json_escape() {
    tr '\t' ' ' \
        | tr -d '\000-\010\013\014\016-\037' \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        | awk '{ printf "%s\\n", $0 }'
}

emit() { # $1 = systemMessage (lehet üres), $2 = additionalContext
    local m c
    m=$(printf '%s' "$1" | json_escape)
    c=$(printf '%s' "$2" | json_escape)
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$m" "$c"
}

f="$cwd/.claude/METHODOLOGY"
choice=""
[ -f "$f" ] && choice=$(head -1 "$f" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

case "$choice" in
  gsd)
    emit "" "MÓDSZERTAN ebben a repóban: GSD. A tervezés/végrehajtás/review/debug munkát a gsd-* skillekkel végezd (/gsd-plan-phase, /gsd-execute-phase, /gsd-code-review, /gsd-debug). A superpowers azonos célú skilljeit (brainstorming, writing-plans, executing-plans, systematic-debugging, requesting-code-review) és a claude-mem tervező skilljeit (make-plan, do) NE használd itt — a superpowers többi, nem ütköző skillje (using-git-worktrees, dispatching-parallel-agents, test-driven-development) használható. Ezt a felhasználó egyszer eldöntötte, ne kérdezd újra."
    ;;
  superpowers|sp)
    emit "" "MÓDSZERTAN ebben a repóban: superpowers. A tervezés/végrehajtás/review/debug munkát a superpowers skilljeivel végezd (brainstorming, writing-plans, executing-plans, subagent-driven-development, systematic-debugging, requesting-code-review, verification-before-completion). A gsd-* skilleket és a claude-mem tervező skilljeit (make-plan, do) NE használd itt, és ne hozz létre .planning/ struktúrát. Ezt a felhasználó egyszer eldöntötte, ne kérdezd újra."
    ;;
  none|nincs)
    emit "" "MÓDSZERTAN ebben a repóban: egyik sem. Ne indíts se GSD-, se superpowers-, se claude-mem make-plan/do folyamatot magadtól; dolgozz közvetlenül, ahogy a feladat kívánja. Ezt a felhasználó egyszer eldöntötte, ne kérdezd újra."
    ;;
  *)
    emit "Ebben a repóban még nincs kiválasztva a vezető módszertan (GSD vagy superpowers). Az első érdemi feladatnál Claude egyszer rá fog kérdezni — vagy futtasd: /bajzi:modszertan" \
         "FIGYELEM: ebben a repóban nincs .claude/METHODOLOGY jelölőfájl, és a GSD meg a superpowers is telepítve lehet. A kettő ugyanazt a területet fedi, ezért AZ ELSŐ olyan feladatnál, ami tervezést, több lépéses végrehajtást, code review-t vagy szisztematikus debugot igényel, EGYSZER kérdezd meg a felhasználót, melyik legyen a vezető ebben a repóban (gsd / superpowers / egyik sem — a claude-mem make-plan/do mindkét esetben háttérbe lép), majd írd a válaszát egyetlen szóként a .claude/METHODOLOGY fájlba. Apró, egylépéses feladatnál ne kérdezz — csak csináld meg."
    ;;
esac
