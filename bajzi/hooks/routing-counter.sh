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
# NO MODEL on the dispatch = the model the AGENT DEFINITION pins. For
# tool_input.subagent_type=<name> (or <plugin>:<name>) the hook reads ONLY the
# YAML frontmatter `model:` line of the first <name>.md found in, in order:
#   <cwd>/.claude/agents/            (project agents)
#   $HOME/.claude/agents/            (user agents)
#   $HOME/.claude/plugins/cache/*/<plugin>/*/agents/          (plugin:name only)
#   $HOME/.claude/plugins/marketplaces/*/plugins/<plugin>/agents/
# Fixed-depth globs, no recursive find, so the lookup stays bounded.
# `model: inherit`, no model line, or no file found = the session's own model,
# never a violation. Built-ins (Explore, general-purpose, Plan) have no file:
# Explore INHERITS the session model (Claude Code docs, "Subagents", since
# v2.1.198), so it is not counted as haiku. KNOWN GAP: agents defined some other
# way (--agents JSON, managed settings, a plugin installed outside these dirs)
# resolve to nothing and are not counted -- an under-count, never an over-count.
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
# payload: only tool_input.model, tool_input.subagent_type and the TOP-LEVEL
# cwd count, so a "model" key in tool_response or in the prompt text is ignored.
#
# DEPENDENCY-FREE: bash, awk, tr, head, tail, cut, date.

set -uo pipefail

input=$(cat 2>/dev/null || true)

# Prints three lines: tool_input.model, top-level cwd, tool_input.subagent_type.
fields=$(printf '%s' "$input" | awk '
function val(d, k, v) {
    gsub(/[\r\n\t]/, " ", v)
    if (d == 1 && k == "cwd" && !have_cwd) { cwd = v; have_cwd = 1 }
    if (d == 2 && isobj[2] && parent[2] == "tool_input" && isobj[1]) {
        if (k == "model" && !have_model) { model = v; have_model = 1 }
        if (k == "subagent_type" && !have_sub) { stype = v; have_sub = 1 }
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
    print model; print cwd; print stype
}' 2>/dev/null) || fields=""

model="" cwd="" sub=""
{ IFS= read -r model; IFS= read -r cwd; IFS= read -r sub; } <<< "$fields" || true
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

# Frontmatter `model:` of an agent file: only between the opening --- (line 1)
# and the closing ---, first 40 lines at most. Prints the raw value or nothing.
fm_model() {
    head -n 40 "$1" 2>/dev/null | tr -d '\r' | awk '
        NR == 1 { if ($0 !~ /^---[ \t]*$/) exit; next }
        /^---[ \t]*$/ { exit }
        /^model[ \t]*:/ { sub(/^model[ \t]*:[ \t]*/, ""); gsub(/["\047]/, ""); sub(/[ \t]+#.*$/, ""); sub(/[ \t]+$/, ""); print; exit }'
}
# No model on the dispatch: resolve the subagent type's definition (see header).
if [ -z "$model" ] && [ -n "$sub" ]; then
    # Names only: no path separators can reach a glob.
    sub=$(printf '%s' "$sub" | tr -cd 'A-Za-z0-9._:-' | head -c 128)
    name="${sub##*:}" plug=""
    case "$sub" in *:*) plug="${sub%:*}"; plug="${plug##*:}" ;; esac
    case "$name$plug" in *..* | .*) name="" ;; esac
    if [ -n "$name" ]; then
        h="${HOME:-/nonexistent}/.claude"
        set -- "$cwd/.claude/agents/$name.md" "$h/agents/$name.md"
        if [ -n "$plug" ]; then
            set -- "$@" "$h"/plugins/cache/*/"$plug"/*/agents/"$name.md" \
                "$h"/plugins/marketplaces/*/plugins/"$plug"/agents/"$name.md"
        fi
        for f in "$@"; do
            [ -f "$f" ] || continue
            model=$(fm_model "$f" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-' | head -c 64)
            break
        done
        [ "$model" = "inherit" ] && model=""
    fi
fi

# Still no model = the session default (inherit, built-ins, not found): never counted.
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
