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
# stdin is parsed by json_fields (lib-json-fields.sh, shared with
# dispatch-guard.sh), a small JSON-aware awk scanner, not a regex over the whole
# payload: only tool_input.model, tool_input.subagent_type and the TOP-LEVEL
# cwd count, so a "model" key in tool_response or in the prompt text is ignored.
# A missing lib reads as an empty payload: nothing counted, still {}.
#
# DEPENDENCY-FREE: bash, awk, tr, head, tail, cut, date.

set -uo pipefail

input=$(cat 2>/dev/null || true)

hookdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fields=""
# shellcheck source=lib-json-fields.sh
if . "$hookdir/lib-json-fields.sh" 2>/dev/null; then
    fields=$(printf '%s' "$input" | json_fields model cwd subagent_type)
fi

model="" cwd="" sub=""
{ IFS= read -r model; IFS= read -r cwd; IFS= read -r sub; } <<< "$fields" || true
# Log-safe model: lowercase, a conservative charset, capped.
model=$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-' | head -c 64)
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

lib="$hookdir/lib-saver-level.sh"
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
