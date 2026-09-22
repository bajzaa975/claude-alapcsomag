#!/usr/bin/env bash
# SessionStart hook -- is this session running in "day-run" working mode, and
# at which saver level?
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
# so it is capped at 80 lines below, by the single head call on the rules file --
# a defensive cap that holds even if the rules file grows. Keep the cap ABOVE the
# real line count of DAY-RUN-RULES.md: a cap under it silently drops the tail of
# the rules and nothing reports it.
#
# SAVER LEVELS. After the day-run rules the hook appends AT MOST ONE saver block
# from skills/mode/, chosen in this order:
#   1. provider is NON-ANTHROPIC and CC_ROUTER_WORKER=1 (set by cc-router on a
#      `glm -p` spawned from a Claude session)
#                                 -> GLM-WORKER.md ONLY, no day-run table: a
#                                    dispatched worker must not orchestrate.
#   2. provider is non-Anthropic otherwise -> SAVER-L3.md, whatever the level
#      says. This is the MECHANICAL check: a session served by GLM (or any other
#      non-Anthropic model) can never be handed the L0-L2 text, which promises
#      Opus reviews it cannot reach.
#   NON-ANTHROPIC = ANTHROPIC_BASE_URL is set and, lowercased, its HOST (scheme,
#   userinfo, path, query, fragment and port stripped) is neither anthropic.com
#   nor a subdomain of it. So z.ai, cc-router's deepseek route, and a URL that
#   only mentions anthropic.com in its query or userinfo all count. Unset or
#   empty = Anthropic.
#   FAIL CLOSED: on a non-Anthropic session whose worker/L3 file is missing or
#   empty, the hook emits a warning-only systemMessage and NEVER the day-run
#   table, which would tell a GLM session its reviews are Opus.
#   3. level = CC_WORKER_MODE (night runner), else first line of
#      $HOME/.claude/worker-mode (`worker` wrapper, a leading UTF-8 BOM is
#      dropped); same normalization as the mode read: claude -> none,
#      light -> SAVER-L1.md, glm -> SAVER-RULES.md (L2),
#      tight -> SAVER-L3.md (a Claude session at tight must queue, not review).
#   4. any other level -> no saver block, and the systemMessage says
#      "worker-mode unreadable, treated as L0".
# L1/L2 also require the dispatch launcher on PATH ("glm", or BAJZI_SAVER_LAUNCHER
# so the tests can probe a command that exists / does not); L3 and the worker
# block do not, the session is already on GLM.
#
# GATE. Anything is emitted only when day-run is on, OR CC_WORKER_MODE is set, OR
# the provider is non-Anthropic. A bare install with none of the three prints {}.
# The hook reads NOTHING besides the two mode files, $HOME/.claude/worker-mode,
# the rules files above and those three env vars.
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

# Provider check: host of ANTHROPIC_BASE_URL, lowercased, must be anthropic.com or
# a subdomain; anything else set there is a non-Anthropic session.
nonanth="no"
url=$(printf '%s' "${ANTHROPIC_BASE_URL:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
if [ -n "$url" ]; then
    host="${url#*://}"      # scheme
    host="${host%%[/?#]*}"  # path, query, fragment
    host="${host##*@}"      # userinfo
    host="${host%%:*}"      # port
    case "$host" in
        anthropic.com | *.anthropic.com) ;;
        *) nonanth="yes" ;;
    esac
fi
env_level=$(printf '%s' "${CC_WORKER_MODE:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

f=""
if [ -f "$cwd/runtime/bajzi-mode" ]; then
    f="$cwd/runtime/bajzi-mode"
elif [ -f "${HOME:-}/.claude/bajzi-mode" ]; then
    f="${HOME:-}/.claude/bajzi-mode"
fi
dayrun="no"
if [ -n "$f" ]; then
    mode=$(head -1 "$f" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    [ "$mode" = "day-run" ] && dayrun="yes"
fi

# Gate: day-run on, a level forced by the runner, or a non-Anthropic provider (a
# glm-started session is L3 whatever the mode files say). None of the three -> silent.
if [ "$dayrun" = "no" ] && [ -z "$env_level" ] && [ "$nonanth" = "no" ]; then
    printf '{}'
    exit 0
fi

mdir="$root/skills/mode"

# A dispatched worker on a non-Anthropic provider gets the worker block and nothing
# else -- and, fail-closed, never the day-run table when that block is missing.
if [ "$nonanth" = "yes" ] && [ "${CC_ROUTER_WORKER:-}" = "1" ]; then
    wb=""
    [ -f "$mdir/GLM-WORKER.md" ] && wb=$(head -20 "$mdir/GLM-WORKER.md" 2>/dev/null)
    if [ -n "$wb" ]; then
        emit "GLM worker (dispatched headless worker)." "$wb"
    else
        emit "GLM worker: GLM-WORKER.md is missing or empty; no rules injected (day-run rules withheld on a non-Anthropic provider)." ""
    fi
    exit 0
fi

level="$env_level"
if [ -z "$level" ] && [ -f "${HOME:-}/.claude/worker-mode" ]; then
    raw=$(head -1 "${HOME:-}/.claude/worker-mode" 2>/dev/null)
    raw="${raw#$'\357\273\277'}"   # a leading UTF-8 BOM (Notepad, PowerShell 5 Out-File)
    level=$(printf '%s' "$raw" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
fi
[ -z "$level" ] && level="claude"
# Mechanical: a non-Anthropic session can never get the L0-L2 text.
[ "$nonanth" = "yes" ] && level="tight"
warn=""
case "$level" in
    claude | light | glm | tight) ;;
    *) warn=" worker-mode unreadable ('${level:0:20}'), treated as L0."; level="claude" ;;
esac

block=""
[ "$dayrun" = "yes" ] && [ -f "$mdir/DAY-RUN-RULES.md" ] && block=$(head -80 "$mdir/DAY-RUN-RULES.md" 2>/dev/null)

launcher="${BAJZI_SAVER_LAUNCHER:-}"
[ -z "$launcher" ] && launcher="glm"
saver_file=""
name=""
case "$level" in
    light) command -v "$launcher" >/dev/null 2>&1 && { saver_file="SAVER-L1.md"; name="L1 (light)"; } ;;
    glm) command -v "$launcher" >/dev/null 2>&1 && { saver_file="SAVER-RULES.md"; name="L2 (glm)"; } ;;
    tight) saver_file="SAVER-L3.md"; name="L3 (tight)" ;;
esac
saver_block=""
[ -n "$saver_file" ] && [ -f "$mdir/$saver_file" ] && saver_block=$(head -40 "$mdir/$saver_file" 2>/dev/null)
if [ -n "$saver_block" ]; then
    if [ -n "$block" ]; then
        block="$block

$saver_block"
    else
        block="$saver_block"
    fi
fi

# FAIL CLOSED: a non-Anthropic session without its L3 text gets a warning only --
# never the day-run table on its own, which says every review is Opus.
if [ "$nonanth" = "yes" ] && [ -z "$saver_block" ]; then
    emit "saver L3 rules missing ($mdir/SAVER-L3.md absent or empty) on a non-Anthropic provider; day-run rules withheld. Reinstall the bajzi plugin." ""
    exit 0
fi

if [ -z "$block" ]; then
    if [ -n "$warn" ]; then
        if [ "$dayrun" = "yes" ]; then emit "day-run mode active ($f).$warn" ""; else emit "saver off:$warn" ""; fi
        exit 0
    fi
    printf '{}'
    exit 0
fi
if [ "$dayrun" = "no" ]; then
    # No day-run mode file behind us: the level came from CC_WORKER_MODE or the
    # provider check. Do NOT claim "day-run mode active" -- no day-run table is in context.
    src="CC_WORKER_MODE"
    [ "$nonanth" = "yes" ] && src="a non-Anthropic provider ($host)"
    emit "saver $name (set by $src).$warn worker --level 0 to turn saver off." "$block"
elif [ -n "$saver_block" ]; then
    [ "$nonanth" = "yes" ] && name="$name, forced by a non-Anthropic provider ($host)"
    emit "day-run mode active ($f), saver $name.$warn /bajzi:mode normal to turn day-run off; worker --level 0 to turn saver off." "$block"
else
    emit "day-run mode active ($f).$warn /bajzi:mode normal to turn it off." "$block"
fi
