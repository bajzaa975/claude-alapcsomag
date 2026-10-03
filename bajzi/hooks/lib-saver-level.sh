# shellcheck shell=bash
# Shared saver-level resolution for the bajzi hooks. SOURCE it, do not run it.
# Sourcing defines functions only: no output, no filesystem access, no variables.
#
# Used by day-run-mode.sh (SessionStart), routing-counter.sh (PostToolUse on
# Agent) and dispatch-guard.sh (PreToolUse on Agent), so the hooks agree BY
# CONSTRUCTION on the gate, the provider and the level. Change the rules here, never in a copy.
#
# saver_resolve <cwd> [<session_id>] sets:
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
#   SAVER_LEVEL         CC_WORKER_MODE, else THIS session's level file
#                       <status dir>/<session_id>.level when the id is SAFE_ID-valid
#                       and the file's first line reads non-empty, else the first line
#                       of $HOME/.claude/worker-mode (the machine default), else
#                       "claude". Both files are read by saver_read_word (leading
#                       UTF-8 BOM dropped, whitespace incl. CR stripped, lowercased);
#                       forced to "tight" on a non-Anthropic provider. NOT
#                       validated (BAJZI_SESSION_LEVEL sits between the session file and
#                       worker-mode, and never opens the gate): an unknown word is passed through for the
#                       caller to reject.
#
# <status dir> = $BAJZI_STATUS_DIR, else ${BAJZI_HOME:-$HOME}/.claude/bajzi/sessions, and
# SAFE_ID = ^[A-Za-z0-9_-]{1,128}$ -- both exactly as hooks/node/lib/session-status.js. An
# unsafe or missing id reads no session file, so it can never name a path outside that dir.
#
# KEEP IN SYNC: the mode-file read
#   head -1 "$f" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
# must stay BYTE-IDENTICAL to the read in skills/mode/SKILL.md. saver_read_word (the two
# level files) is that read after dropping a leading BOM, and SKILL.md says so.
#
# DEPENDENCY-FREE: bash, tr, head. Never fails.

# saver_safe_id <id>: status 0 when <id> matches SAFE_ID. The class is spelled out, not a range,
# so the locale cannot widen it; anything non-ASCII is outside it, so ${#1} is the byte length.
saver_safe_id() {
    case "${1:-}" in
        '' | *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) return 1 ;;
    esac
    [ "${#1}" -le 128 ]
}

# saver_read_word <file>: prints the level word read from <file>; nothing when it is not a file.
saver_read_word() {
    local _raw
    [ -f "$1" ] || return 0
    _raw=$(head -1 "$1" 2>/dev/null)
    _raw="${_raw#$'\357\273\277'}"   # a leading UTF-8 BOM (Notepad, PowerShell 5 Out-File)
    printf '%s' "$_raw" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
}

# saver_session_id <payload>: prints the string value of the FIRST "session_id" key in a hook
# payload (Claude Code writes the top-level one first), unvalidated -- saver_resolve applies
# SAFE_ID. Pure bash. A "session_id" quoted inside a string value is escaped (\"session_id\")
# in JSON, so it never matches; json_fields (lib-json-fields.sh) reads only tool_input keys.
# Only the first 4096 characters are searched: bash's ${x#*pat} is quadratic in the length,
# and a 300 KB tool_response without the key took 87 s. No id there = no session file.
saver_session_id() {
    local _h="${1:0:4096}" _r _re='^[[:space:]]*:[[:space:]]*"([^"\\]*)"'
    _r="${_h#*\"session_id\"}"
    [ "$_r" = "$_h" ] && return 0
    [[ $_r =~ $_re ]] && printf '%s' "${BASH_REMATCH[1]}"
    return 0
}

saver_resolve() { # $1 = cwd, $2 = session id (optional)
    local _cwd="${1:-}" _sid="${2:-}" _url _mode
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
    if [ -z "$SAVER_LEVEL" ] && saver_safe_id "$_sid"; then
        SAVER_LEVEL=$(saver_read_word "${BAJZI_STATUS_DIR:-${BAJZI_HOME:-${HOME:-}}/.claude/bajzi/sessions}/$_sid.level")
    fi
    # BAJZI_SESSION_LEVEL: a level inherited from a parent session; like a level file it never opens the gate.
    [ -z "$SAVER_LEVEL" ] && SAVER_LEVEL=$(printf '%s' "${BAJZI_SESSION_LEVEL:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    [ -z "$SAVER_LEVEL" ] && SAVER_LEVEL=$(saver_read_word "${HOME:-}/.claude/worker-mode")
    [ -z "$SAVER_LEVEL" ] && SAVER_LEVEL="claude"
    # Mechanical: a non-Anthropic session is always L3.
    [ "$SAVER_NON_ANTHROPIC" = "yes" ] && SAVER_LEVEL="tight"
    return 0
}
