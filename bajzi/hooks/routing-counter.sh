#!/usr/bin/env bash
# PostToolUse(Agent) hook -- count sub-agent dispatches that bypass the saver
# level's GLM rung. It only COUNTS: it never blocks, never fails, and always
# prints exactly {} and exits 0, whatever arrives on stdin.
#
# A VIOLATION is a dispatch whose tool_input.model is
#   haiku   at level light, glm or tight (L1-L3: flash work belongs on GLM), or
#   sonnet  at level glm or tight        (L2-L3: sonnet work belongs on GLM),
# UNLESS a GLM peak refusal (cc-router, exit 75) was logged in the last 10
# minutes: then GLM was not available and falling back to Claude is correct.
# opus is never a violation. Model names match as substrings, so a full id
# (claude-haiku-4-5) counts like the alias.
#
# NO MODEL on the dispatch = the session's own model, never a violation. The
# built-in Explore agent INHERITS the session model (Claude Code docs,
# "Subagents", since v2.1.198), so it is not counted as haiku either.
#
# GATE and LEVEL come from lib-saver-level.sh, the resolver the SessionStart
# hook (day-run-mode.sh) uses, so the two agree by construction: the counter
# acts only when day-run is on, OR CC_WORKER_MODE is set, OR the provider is
# non-Anthropic (which also forces level tight). With the gate closed it
# touches nothing -- a plain install must not drop runtime/ files into every
# repo the owner opens.
#
# Writes one line per violation to <cwd>/runtime/routing-violations.log:
#   <ISO-UTC> level=<level> model=<model>
# Peak log: $CC_PEAK_LOG, else $HOME/.claude/glm-peak-refusals.log; its last
# line starts with the refusal's ISO time (cc-router writes toISOString()).
#
# stdin is parsed by a small JSON-aware awk scanner, not a regex over the whole
# payload: only tool_input.model and the TOP-LEVEL
# cwd count, so a "model" key in tool_response or in the prompt text is ignored.
#
# DEPENDENCY-FREE: bash, awk, tr, head, tail, cut, date.

set -uo pipefail

input=$(cat 2>/dev/null || true)

# Prints two lines: tool_input.model, top-level cwd.
fields=$(printf '%s' "$input" | awk '
function val(d, k, v) {
    gsub(/[\r\n\t]/, " ", v)
    if (d == 1 && k == "cwd" && !have_cwd) { cwd = v; have_cwd = 1 }
    if (d == 2 && isobj[2] && parent[2] == "tool_input" && isobj[1]) {
        if (k == "model" && !have_model) { model = v; have_model = 1 }
    }
}
{ s = s $0 "\n" }
END {
    n = length(s); d = 0; i = 1
    while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") {
            j = i + 1; v = ""
            while (j <= n) {
                e = substr(s, j, 1)
                if (e == "\\") {
                    e2 = substr(s, j + 1, 1)
                    if (e2 == "n" || e2 == "r" || e2 == "t") v = v " "
                    else if (e2 == "u") { v = v "?"; j += 4 }
                    else if (e2 != "b" && e2 != "f") v = v e2
                    j += 2; continue
                }
                if (e == "\"") break
                v = v e; j++
            }
            i = j + 1
            k = i
            while (k <= n && substr(s, k, 1) ~ /[ \t\r\n]/) k++
            if (d >= 1 && isobj[d] && substr(s, k, 1) == ":") { key[d] = v; i = k + 1; continue }
            val(d, key[d], v)
            continue
        }
        if (c == "{" || c == "[") {
            d++; isobj[d] = (c == "{"); parent[d] = key[d - 1]; key[d] = ""
        } else if (c == "}" || c == "]") {
            if (d == 2 && isobj[2] && parent[2] == "tool_input") ti_done = 1
            if (d > 0) d--
            if (ti_done && have_cwd) break   # skip scanning a large tool_response
        }
        i++
    }
    print model; print cwd
}' 2>/dev/null) || fields=""

model="" cwd=""
{ IFS= read -r model; IFS= read -r cwd; } <<< "$fields" || true
# Log-safe model: lowercase, a conservative charset, capped.
model=$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-' | head -c 64)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-saver-level.sh"
# shellcheck source=lib-saver-level.sh
if ! . "$lib" 2>/dev/null || ! saver_resolve "$cwd"; then
    printf '{}'
    exit 0
fi
if [ "$SAVER_GATE_OPEN" != "yes" ]; then
    printf '{}'
    exit 0
fi
level="$SAVER_LEVEL"

# No model = the session default (Explore included, see the header): never counted.
v="no"
case "$level:$model" in
    light:*haiku* | glm:*haiku* | tight:*haiku* | glm:*sonnet* | tight:*sonnet*) v="yes" ;;
esac

if [ "$v" = "yes" ]; then
    peak="${CC_PEAK_LOG:-${HOME:-}/.claude/glm-peak-refusals.log}"
    if [ -f "$peak" ]; then
        last=$(tail -n 1 "$peak" 2>/dev/null | tr -d '\r' | cut -c1-19)
        now=$(date -u +%s 2>/dev/null || echo 0)
        then_s=$(date -u -d "$last" +%s 2>/dev/null || echo 0)
        case "$now$then_s" in *[!0-9]*) now=0; then_s=0 ;; esac
        age=$((now - then_s))
        # A refusal in the last 10 min excuses the fallback. A garbage or future
        # stamp excuses nothing.
        [ "$then_s" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -lt 600 ] && v="no"
    fi
fi

if [ "$v" = "yes" ]; then
    { mkdir -p "$cwd/runtime" \
        && printf '%s level=%s model=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$model" \
            >> "$cwd/runtime/routing-violations.log"; } 2>/dev/null || true
fi
printf '{}'
exit 0
