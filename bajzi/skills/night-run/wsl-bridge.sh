#!/usr/bin/env bash
# wsl-bridge.sh - runs the Linux night-run skill steps inside WSL on the same PC, for a session
# on native Windows (Git Bash Bash tool). Subcommands: pick | check | run | launch <NIGHT_DIR>.
# wsl.exe, powershell.exe, cygpath and uname are resolved through PATH only (tests stub them).
#   pick    print DISTRO=<d>; exit 3 when no distro has the tools.
#   check   pick + bajzi version skew (exit 4) + gh auth (exit 5); print KEY=VALUE lines.
#   run     read a bash step on stdin, run it in WSL with CLAUDE_PLUGIN_ROOT set, pass the exit code.
#           Skips the lookups when DISTRO, WSL_CWD and WSL_PLUGIN_ROOT are all set in the environment.
#   launch  start the hidden detached night-hold.ps1 for <NIGHT_DIR> (a WSL path).
# shellcheck disable=SC2016  # remote scripts are single-quoted on purpose: the WSL shell expands them
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
TOOLS='command -v flock setsid claude gh git node python3'
PLUGIN_CACHE='$HOME/.claude/plugins/cache/bajzi-plugins/bajzi'

usage() { echo "usage: wsl-bridge.sh pick | check | run | launch <NIGHT_DIR>  (Git Bash on Windows only)" >&2; exit 2; }
fail() { echo "wsl-bridge: $2" >&2; exit "$1"; }

case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) ;; *) usage;; esac
SUB=${1:-}
case "$SUB" in pick|check|run|launch) ;; *) usage;; esac

# Sets DISTRO: BAJZI_WSL_DISTRO if given (still verified), else the first distro with all tools.
pick() {
  local list d
  if [ -n "${BAJZI_WSL_DISTRO:-}" ]; then list=$BAJZI_WSL_DISTRO
  else list=$(wsl.exe -l -q 2>/dev/null | tr -d '\000\r'); fi   # wsl.exe prints UTF-16
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$d" in docker-desktop*) continue;; esac
    if wsl.exe -d "$d" -- bash -lc "$TOOLS" >/dev/null 2>&1; then DISTRO=$d; return 0; fi
  done <<EOT
$list
EOT
  fail 3 "no WSL distro has flock, setsid, claude, gh, git, node and python3 (docker-desktop distros are skipped; BAJZI_WSL_DISTRO=<name> picks one)"
}

# Sets WSL_CWD and WSL_PLUGIN_ROOT, WSL_VERSION, WSL_HOME for $DISTRO. WIN_PWD = Windows path of $PWD.
WIN_PWD=$(cygpath -w "$PWD")
lookup() {
  local out
  out=$(wsl.exe -d "$DISTRO" -- bash -lc "d=$PLUGIN_CACHE; v=\$(ls -1 \"\$d\" 2>/dev/null | sort -V | tail -n1); echo \"\$v|\$d/\$v|\$HOME\"") || fail 3 "cannot query WSL distro $DISTRO"
  out=$(printf '%s' "$out" | tr -d '\r' | tail -n1)
  WSL_VERSION=${out%%|*}; out=${out#*|}
  WSL_PLUGIN_ROOT=${out%%|*}; WSL_HOME=${out#*|}
  WSL_CWD=$(printf '%s\n' "$WIN_PWD" | wsl.exe -d "$DISTRO" -- bash -lc 'IFS= read -r p; wslpath -a "$p"' | tr -d '\r') \
    && [ -n "$WSL_CWD" ] || fail 3 "wslpath could not map $WIN_PWD in $DISTRO"
}

win_version() {
  local root=${CLAUDE_PLUGIN_ROOT:-} v
  [ -n "$root" ] || fail 2 "CLAUDE_PLUGIN_ROOT is not set"
  root=${root//\\//}; root=${root%/}; v=${root##*/}
  case "$v" in [0-9]*.[0-9]*) ;; *) v=$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" 2>/dev/null | head -n1);; esac
  [ -n "$v" ] || fail 2 "cannot read the Windows bajzi version from $CLAUDE_PLUGIN_ROOT"
  WIN_VERSION=$v
}

case "$SUB" in
  pick) pick; echo "DISTRO=$DISTRO";;
  check)
    pick; lookup; win_version
    if [ "$WSL_VERSION" != "$WIN_VERSION" ] && [ "$(printf '%s\n%s\n' "$WSL_VERSION" "$WIN_VERSION" | sort -V | head -n1)" = "$WSL_VERSION" ]; then
      fail 4 "bajzi in WSL is ${WSL_VERSION:-missing}, Windows has $WIN_VERSION; update it in WSL with: claude plugin update bajzi@bajzi-plugins"
    fi
    wsl.exe -d "$DISTRO" -- bash -lc 'gh auth status' >/dev/null 2>&1 || fail 5 "gh is not logged in inside WSL ($DISTRO); run gh auth login there"
    echo "DISTRO=$DISTRO"; echo "WSL_CWD=$WSL_CWD"; echo "WSL_PLUGIN_ROOT=$WSL_PLUGIN_ROOT"
    echo "WSL_VERSION=$WSL_VERSION"; echo "WIN_VERSION=$WIN_VERSION"
    printf 'WIN_NIGHT_ROOT=\\\\wsl.localhost\\%s%s\\night-runs\n' "$DISTRO" "${WSL_HOME//\//\\}";;
  run)
    if [ -z "${DISTRO:-}" ] || [ -z "${WSL_CWD:-}" ] || [ -z "${WSL_PLUGIN_ROOT:-}" ]; then pick; lookup; fi
    # The step goes through stdin, never through wsl.exe arguments; the prefix is the only addition.
    { printf 'export CLAUDE_PLUGIN_ROOT=%q; cd %q;\n' "$WSL_PLUGIN_ROOT" "$WSL_CWD"; cat; } \
      | wsl.exe -d "$DISTRO" --cd "$WIN_PWD" -- bash -l -s
    exit $?;;
  launch)
    ND=${2:-}; [ -n "$ND" ] || usage
    pick
    # ponytail: paths with spaces are only handled for the ps1 path; ND is ~/night-runs/<project>.
    UNTIL=$(printf '%s\n' "$ND" | wsl.exe -d "$DISTRO" -- bash -lc 'IFS= read -r nd; dl=$(sed -n "s/.*--deadline \"\([^\"]*\)\".*/\1/p" "$nd/launch.sh" | head -n1); if u=$(date -d "$dl" +%s 2>/dev/null); then echo $((u+7200)); else echo $(( $(date +%s)+259200 )); fi' | tr -d '\r' | tail -n1)
    [ -n "$UNTIL" ] || fail 3 "cannot read the deadline from $ND/launch.sh in $DISTRO"
    HOLD_PS1=$(cygpath -w "$(cd "$(dirname "$0")" && pwd)/night-hold.ps1")
    powershell.exe -NoProfile -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"$HOLD_PS1\"','-Distro','$DISTRO','-NightDir','$ND','-UntilEpoch','$UNTIL'" || fail 3 "could not start the holder"
    echo "holder started"; echo "$ND/logs/hold.log";;
esac
