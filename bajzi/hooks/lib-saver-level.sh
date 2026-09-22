# shellcheck shell=bash
# Shared saver-level resolution for the bajzi hooks. SOURCE it, do not run it.
# Sourcing defines functions only: no output, no filesystem access, no variables.
#
# Used by day-run-mode.sh (SessionStart) and routing-counter.sh (PostToolUse on
# Agent), so both hooks agree BY CONSTRUCTION on the gate, the provider and the
# level. Change the rules here, never in a copy.
#
# saver_resolve <cwd> sets:
#   SAVER_HOST          lowercased host of ANTHROPIC_BASE_URL (empty when unset)
#   SAVER_NON_ANTHROPIC yes|no -- ANTHROPIC_BASE_URL set and its HOST (scheme,
#                       path/query/fragment, userinfo and port stripped) is
#                       neither anthropic.com nor a subdomain of it. A backslash
#                       ends the authority like a slash does, because Node's URL
#                       parser (what Claude Code connects with) treats `\` as `/`
#                       for http(s): https://evil.com\@api.anthropic.com goes to
#                       evil.com, so it must NOT read as Anthropic.
#   SAVER_ENV_LEVEL     CC_WORKER_MODE, whitespace-stripped and lowercased
#   SAVER_DAYRUN_FILE   first of <cwd>/runtime/bajzi-mode, $HOME/.claude/bajzi-mode
#                       that exists (empty when neither does)
#   SAVER_DAYRUN        yes|no -- that file's first line normalizes to "day-run"
#   SAVER_GATE_OPEN     yes|no -- day-run on, OR CC_WORKER_MODE set, OR a
#                       non-Anthropic provider. The worker-mode FILE alone never
#                       opens it: a bare install must stay silent.
#   SAVER_LEVEL         CC_WORKER_MODE, else the first line of
#                       $HOME/.claude/worker-mode (leading UTF-8 BOM dropped,
#                       whitespace incl. CR stripped, lowercased), else "claude";
#                       forced to "tight" on a non-Anthropic provider. NOT
#                       validated: an unknown word is passed through for the
#                       caller to reject.
#
# KEEP IN SYNC: the mode-file read
#   head -1 "$f" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
# must stay BYTE-IDENTICAL to the read in skills/mode/SKILL.md.
#
# DEPENDENCY-FREE: bash, tr, head. Never fails.

saver_resolve() { # $1 = cwd
    local _cwd="${1:-}" _url _raw _mode
    SAVER_HOST=""
    SAVER_NON_ANTHROPIC="no"
    _url=$(printf '%s' "${ANTHROPIC_BASE_URL:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [ -n "$_url" ]; then
        SAVER_HOST="${_url#*://}"                # scheme
        SAVER_HOST="${SAVER_HOST%%[/?#\\]*}"     # path, query, fragment; `\` = `/` to Node
        SAVER_HOST="${SAVER_HOST##*@}"           # userinfo
        SAVER_HOST="${SAVER_HOST%%:*}"           # port
        case "$SAVER_HOST" in
            anthropic.com | *.anthropic.com) ;;
            *) SAVER_NON_ANTHROPIC="yes" ;;
        esac
    fi
    SAVER_ENV_LEVEL=$(printf '%s' "${CC_WORKER_MODE:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

    SAVER_DAYRUN_FILE=""
    if [ -f "$_cwd/runtime/bajzi-mode" ]; then
        SAVER_DAYRUN_FILE="$_cwd/runtime/bajzi-mode"
    elif [ -f "${HOME:-}/.claude/bajzi-mode" ]; then
        SAVER_DAYRUN_FILE="${HOME:-}/.claude/bajzi-mode"
    fi
    SAVER_DAYRUN="no"
    if [ -n "$SAVER_DAYRUN_FILE" ]; then
        _mode=$(head -1 "$SAVER_DAYRUN_FILE" 2>/dev/null | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
        [ "$_mode" = "day-run" ] && SAVER_DAYRUN="yes"
    fi

    SAVER_GATE_OPEN="no"
    if [ "$SAVER_DAYRUN" = "yes" ] || [ -n "$SAVER_ENV_LEVEL" ] || [ "$SAVER_NON_ANTHROPIC" = "yes" ]; then
        SAVER_GATE_OPEN="yes"
    fi

    SAVER_LEVEL="$SAVER_ENV_LEVEL"
    if [ -z "$SAVER_LEVEL" ] && [ -f "${HOME:-}/.claude/worker-mode" ]; then
        _raw=$(head -1 "${HOME:-}/.claude/worker-mode" 2>/dev/null)
        _raw="${_raw#$'\357\273\277'}"   # a leading UTF-8 BOM (Notepad, PowerShell 5 Out-File)
        SAVER_LEVEL=$(printf '%s' "$_raw" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    fi
    [ -z "$SAVER_LEVEL" ] && SAVER_LEVEL="claude"
    # Mechanical: a non-Anthropic session is always L3.
    [ "$SAVER_NON_ANTHROPIC" = "yes" ] && SAVER_LEVEL="tight"
    return 0
}
