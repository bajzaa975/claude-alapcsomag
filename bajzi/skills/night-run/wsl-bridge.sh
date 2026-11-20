#!/usr/bin/env bash
# wsl-bridge.sh - runs the Linux night-run skill steps inside WSL on the same PC, for a session
# on native Windows (Git Bash Bash tool). Subcommands: pick | check | run | launch <NIGHT_DIR>.
# wsl.exe, powershell.exe, cygpath and uname are resolved through PATH only (tests stub them).
#   pick    print DISTRO=<d>; exit 3 when no distro has the tools.
#   check   pick + bajzi version skew (exit 4) + gh auth (exit 5) + claude login (exit 6) + GitHub
#           access to the project's origin repo (exit 7); print KEY=VALUE lines.
#   run     read a bash step on stdin, run it in WSL with CLAUDE_PLUGIN_ROOT set, pass the exit code.
#           Skips the lookups when DISTRO, WSL_CWD and WSL_PLUGIN_ROOT are all set in the environment.
#   launch  start the hidden detached night-hold.ps1 for <NIGHT_DIR> (a WSL path), wait for launch.sh to
#           finish, print its output (logs/hold.log); exit 8 when launch.sh refused or never reported.
# Every wsl.exe call that carries a script uses --exec (no outer shell would expand $vars and $(...) first)
# and no double quotes in the script (wsl.exe argument parsing).
# shellcheck disable=SC2016  # remote scripts are single-quoted on purpose: the WSL shell expands them
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
TOOLS='for t in flock setsid claude gh git node python3; do command -v $t >/dev/null || exit 1; done'
LOOKUP='d=$HOME/.claude/plugins/cache/bajzi-plugins/bajzi; v=$(ls -1 $d 2>/dev/null | sort -V | tail -n1); echo $v\|$d/$v\|$HOME'
# $1 = NIGHT_DIR; the launch.sh deadline is "YYYY-MM-DD HH:MM" local time; fallback now + 72 h.
DEADLINE='nd=$1; dl=$(sed -n '\''s/.*--deadline .\([0-9][0-9: -]*[0-9]\).*/\1/p'\'' $nd/launch.sh | head -n1); set -- $dl; if [ $# -eq 2 ] && u=$(date -d ${1}T$2 +%s 2>/dev/null); then echo $((u+7200)); else echo $(( $(date +%s)+259200 )); fi'
HOLD_WAIT='f=$1/logs/hold.log; i=0; while [ $i -lt $2 ] && ! grep -q ^LAUNCH-EXIT= $f 2>/dev/null; do sleep 1; i=$((i+1)); done; cat $f 2>/dev/null'

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
    # </dev/null: wsl.exe relays stdin to Linux and would swallow the rest of the list read below
    if wsl.exe -d "$d" --exec bash -lc "$TOOLS" >/dev/null 2>&1 </dev/null; then DISTRO=$d; return 0; fi
  done <<EOT
$list
EOT
  fail 3 "no WSL distro has flock, setsid, claude, gh, git, node and python3 (docker-desktop distros are skipped; BAJZI_WSL_DISTRO=<name> picks one)"
}

# Sets WSL_CWD and WSL_PLUGIN_ROOT, WSL_VERSION, WSL_HOME for $DISTRO. WIN_PWD = Windows path of $PWD.
WIN_PWD=$(cygpath -w "$PWD")
lookup() {
  local out
  out=$(wsl.exe -d "$DISTRO" --exec bash -lc "$LOOKUP" </dev/null) || fail 3 "cannot query WSL distro $DISTRO"
  out=$(printf '%s' "$out" | tr -d '\r' | tail -n1)
  WSL_VERSION=${out%%|*}; out=${out#*|}
  WSL_PLUGIN_ROOT=${out%%|*}; WSL_HOME=${out#*|}
  WSL_CWD=$(wsl.exe -d "$DISTRO" --exec wslpath -a "$WIN_PWD" </dev/null | tr -d '\r') \
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
    wsl.exe -d "$DISTRO" --exec bash -lc 'gh auth status' >/dev/null 2>&1 </dev/null || fail 5 "gh is not logged in inside WSL ($DISTRO); run gh auth login there"
    wsl.exe -d "$DISTRO" --exec bash -lc 'claude auth status' >/dev/null 2>&1 </dev/null || fail 6 "claude is not logged in inside WSL ($DISTRO); run claude there and log in"
    wsl.exe -d "$DISTRO" --cd "$WIN_PWD" --exec bash -lc 'u=$(git remote get-url origin) && gh repo view $u' >/dev/null 2>&1 </dev/null || fail 7 "GitHub cannot see the project repo (origin of $WIN_PWD) from WSL ($DISTRO); check the origin remote and gh access there"
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
    # ponytail: ND is ~/night-runs/<project>; no spaces handled (the scripts above leave $nd unquoted).
    UNTIL=$(wsl.exe -d "$DISTRO" --exec bash -lc "$DEADLINE" _ "$ND" </dev/null | tr -d '\r' | tail -n1)
    [ -n "$UNTIL" ] || fail 3 "cannot read the deadline from $ND/launch.sh in $DISTRO"
    # Fresh hold.log: the wait below must not see a marker from an earlier night.
    wsl.exe -d "$DISTRO" --exec bash -c 'mkdir -p $1/logs; : > $1/logs/hold.log' _ "$ND" </dev/null || fail 3 "cannot write $ND/logs in $DISTRO"
    HOLD_PS1=$(cygpath -w "$(cd "$(dirname "$0")" && pwd)/night-hold.ps1")
    powershell.exe -NoProfile -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"$HOLD_PS1\"','-Distro','$DISTRO','-NightDir','$ND','-UntilEpoch','$UNTIL'" || fail 3 "could not start the holder"
    # The holder appends LAUNCH-EXIT=<rc> after launch.sh (about 10 s); its refusals land only in hold.log.
    LOG=$(wsl.exe -d "$DISTRO" --exec bash -c "$HOLD_WAIT" _ "$ND" "${BAJZI_HOLD_WAIT:-90}" </dev/null | tr -d '\r')
    printf '%s\n' "$LOG"
    case "$(printf '%s\n' "$LOG" | grep '^LAUNCH-EXIT=' | tail -n1)" in
      LAUNCH-EXIT=0) ;;
      '') fail 8 "launch.sh did not finish in time; read $ND/logs/hold.log before anything else";;
      *) fail 8 "launch.sh refused or failed (output above); nothing was launched unless it says launched";;
    esac
    echo "holder started"; echo "$ND/logs/hold.log";;
esac
