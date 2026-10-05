#!/usr/bin/env bash
# supervise.sh — the 30-minute mid-story supervisor of a /bajzi:night-run run.
#
# WHY IT EXISTS
# The tier-1 triage tick (night-watch.sh) wakes only on a NEW terminal row in state.txt, so a
# story stuck in its first 20 minutes is noticed only when its 3-hour budget ends. This loop
# runs a FRESH headless Claude session every SUPERVISE_INTERVAL seconds that checks the live
# story and fixes environment / permission / harness causes (SUPERVISE-PROMPT.md says how).
#
# USAGE
#   supervise.sh --config <path/to/config.env>      (or NIGHT_CONFIG=<path>)
# run.sh spawns it detached next to night-watch.sh when SUPERVISE=1 (the default), stdout and
# stderr appended to $NIGHT_DIR/logs/supervise.out.
#
# CONFIG KEYS (defaults when absent)
#   SUPERVISE_INTERVAL=1800      seconds; the loop SLEEPS FIRST, then ticks
#   SUPERVISE_TICK_TIMEOUT=1500  hard cap of one tick; must be < SUPERVISE_INTERVAL
#   NIGHT_DIR                    required
#
# EACH ITERATION, after the sleep
#   1. re-read started_epoch from $NIGHT_DIR/run.meta (a relaunch republishes it)
#   2. exit (one line in supervisor.log) when $NIGHT_DIR/SUPERVISE-STOP (not older than the
#      earlier of started_epoch and this supervisor's start: NIGHT_DIR is permanent) or
#      $NIGHT_DIR/STOP exists, $NIGHT_DIR/finished holds an epoch >= started_epoch, or it is past
#      run.meta deadline_epoch + 1800 with no such finished (night-watch.sh's EXPIRED)
#   3. else ONE tick: `claude -p` with $NIGHT_DIR/SUPERVISE-PROMPT.md on stdin, cwd NIGHT_DIR,
#      model = entry [0] of the reviewer allow-list read NOW (reviewer-models.js --first),
#      --permission-mode bypassPermissions, --settings $BASE/.claude/settings.local.json (the
#      project deny list; missing = SUPERVISE MISCONFIGURED, claude not launched, as in
#      triage_check), provider env (ANTHROPIC_*, CC_ROUTER_*, ...) scrubbed so
#      it can never run on GLM, stream-json checked by tick-lib.sh: an init record with another
#      model or permission mode kills the tick (SUPERVISE MISCONFIGURED in supervisor.log).
#
# FILES under $NIGHT_DIR
#   supervisor.log               start/exit lines, SUPERVISE verdicts, and the tick's own one-line
#                                `<ISO> OK|FIXED|PROBLEM <story> <sentence>`
#   logs/supervisor-ticks.log    each tick's decoded result text + `<ISO> tick exit=<rc>`
#   supervise/<epoch>-<pid>.*    raw stream (.jsonl), stderr (.err), tick pid (.pid)
#   supervise.pid                single instance: a live supervise.sh for this run => exit 0
#   SUPERVISE-STOP               the owner's off switch for the supervisor alone; a file older
#                                than this run is an earlier night's and is ignored
#
# It never holds run.sh's lock (fd 9 is closed at start) and never signals a process it did not
# start: the only kills are the tick it launched (tick-lib.sh, and on TERM/INT) and its own sleep.

set -u
exec 9>&-

PROG=supervise.sh
CONFIG=${NIGHT_CONFIG:-}
usage(){ sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --config)  [ $# -ge 2 ] || { echo "$PROG: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    -h|--help) usage; exit 0;;
    *) echo "$PROG: unknown argument '$1' (see --help)" >&2; exit 2;;
  esac
  shift
done
[ -n "$CONFIG" ] || { echo "$PROG: no config — pass --config <path> or set NIGHT_CONFIG." >&2; exit 2; }
[ -f "$CONFIG" ] || { echo "$PROG: config file not found: $CONFIG" >&2; exit 2; }
# shellcheck source=/dev/null
. "$CONFIG"
CONFIG_ABS=$(readlink -f "$CONFIG" 2>/dev/null) || CONFIG_ABS=""
[ -n "$CONFIG_ABS" ] || CONFIG_ABS=$CONFIG

NIGHT_DIR=${NIGHT_DIR:-}
BASE=${BASE:-}
SUPERVISE_INTERVAL=${SUPERVISE_INTERVAL:-1800}
SUPERVISE_TICK_TIMEOUT=${SUPERVISE_TICK_TIMEOUT:-1500}
[ -n "$NIGHT_DIR" ] || { echo "$PROG: $CONFIG has no NIGHT_DIR" >&2; exit 2; }
[ -d "$NIGHT_DIR" ] || { echo "$PROG: NIGHT_DIR does not exist: $NIGHT_DIR" >&2; exit 2; }
for v in SUPERVISE_INTERVAL SUPERVISE_TICK_TIMEOUT; do
  eval "val=\${$v}"
  case "$val" in ''|*[!0-9]*|0) echo "$PROG: $v must be a whole number of seconds > 0, got '$val'" >&2; exit 2;; esac
done
[ "$SUPERVISE_TICK_TIMEOUT" -lt "$SUPERVISE_INTERVAL" ] || {
  echo "$PROG: SUPERVISE_TICK_TIMEOUT ($SUPERVISE_TICK_TIMEOUT) must be less than SUPERVISE_INTERVAL ($SUPERVISE_INTERVAL)" >&2; exit 2; }

SKILL_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
REVIEWER_MODELS=$SKILL_DIR/../../hooks/node/lib/reviewer-models.js
META=$NIGHT_DIR/run.meta
FINISHED=$NIGHT_DIR/finished
PROMPT=$NIGHT_DIR/SUPERVISE-PROMPT.md
SUP_LOG=$NIGHT_DIR/supervisor.log
TICKS_LOG=$NIGHT_DIR/logs/supervisor-ticks.log
TICK_DIR=$NIGHT_DIR/supervise
PIDFILE=$NIGHT_DIR/supervise.pid

say(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
note(){ say "$*"; say "$*" >>"$SUP_LOG" 2>/dev/null; }

# shellcheck source=tick-lib.sh
. "$SKILL_DIR/tick-lib.sh" || { echo "$PROG: cannot source $SKILL_DIR/tick-lib.sh" >&2; exit 2; }
TICK_LABEL=SUPERVISE
TICK_LOG=$SUP_LOG
TICK_RESULT_LOG=$TICKS_LOG
# Provider env scrubbed for the tick, the way cc-router.js does for its plain-Claude provider:
# every ANTHROPIC_* (base URL, token, model overrides), the router/worker selectors and the
# subagent model. The init-record check is the second belt.
TICK_ENV=(env)
for v in $(compgen -e); do
  case "$v" in
    ANTHROPIC_*|CC_ROUTER_*|CC_WORKER_MODE|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDECODE) TICK_ENV+=(-u "$v");;
  esac
done

claim_pidfile "$PIDFILE"
SUP_START=$(date +%s)
SLEEP_PID=""
TICK_BG=""      # the backgrounded tick subshell, while a tick runs
TICK_PIDF=""    # its .pid file: the pid tick_launch execs timeout (-> claude) under
# shellcheck disable=SC2317  # both run from traps
cleanup(){
  local mine
  if [ -f "$PIDFILE" ]; then
    mine=$(head -1 "$PIDFILE" 2>/dev/null | tr -dc '0-9')
    [ "$mine" = "$$" ] && rm -f "$PIDFILE"
  fi
}
# shellcheck disable=SC2317
on_signal(){
  local tp i
  say "$PROG: signalled — stopping."
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  if [ -n "$TICK_BG" ]; then
    # TERM (never INT: async children start with SIGINT ignored) to the pid that exec'd timeout,
    # which passes it on to claude; then the subshell that waits for it.
    tp=$(tr -dc '0-9' <"$TICK_PIDF" 2>/dev/null)
    if [ -n "$tp" ]; then
      kill "$tp" 2>/dev/null
      for i in $(seq 1 50); do kill -0 "$tp" 2>/dev/null || break; sleep 0.1; done
    fi
    kill "$TICK_BG" 2>/dev/null
  fi
  cleanup; exit 0
}
trap on_signal INT TERM
trap cleanup EXIT

started_epoch(){ sed -n 's/^started_epoch=//p' "$META" 2>/dev/null | tail -1 | tr -dc '0-9'; }

# SUPERVISE-STOP is dated like night-watch.sh dates STOP: NIGHT_DIR is permanent, so a file older
# than the EARLIER of started_epoch and this supervisor's own start is an earlier night's (the
# earlier: a relaunch rewrites started_epoch while this supervisor keeps running). An undatable
# run or file is honoured: fail closed.
sup_stop_live(){
  local f=$NIGHT_DIR/SUPERVISE-STOP st floor=$SUP_START m
  [ -e "$f" ] || return 1
  st=$(started_epoch)
  [ -n "$st" ] || return 0
  [ "$st" -lt "$floor" ] && floor=$st
  m=$(stat -c %Y "$f" 2>/dev/null | tr -dc '0-9')
  [ -n "$m" ] || return 0
  [ "$m" -ge "$floor" ]
}

# 0 = stop now (already logged), 1 = keep going
should_exit(){
  local st fin dl
  if sup_stop_live; then note "supervisor stopped (SUPERVISE-STOP)"; return 0; fi
  if [ -e "$NIGHT_DIR/STOP" ]; then note "supervisor stopped (STOP present)"; return 0; fi
  st=$(started_epoch)
  fin=$(head -1 "$FINISHED" 2>/dev/null | tr -dc '0-9')
  if [ -n "$st" ] && [ -n "$fin" ] && [ "$fin" -ge "$st" ]; then
    note "supervisor exits: runner finished (finished=$fin >= started_epoch=$st)"
    return 0
  fi
  # night-watch.sh's EXPIRED: a runner that died without writing finished must not leave us ticking.
  dl=$(sed -n 's/^deadline_epoch=//p' "$META" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "$dl" ] && [ "$(date +%s)" -gt $((dl + 1800)) ]; then
    note "supervisor exits: past deadline_epoch+1800 with no finished marker (deadline_epoch=$dl)"
    return 0
  fi
  return 1
}

tick(){
  local model raw settings=$BASE/.claude/settings.local.json
  if [ ! -f "$PROMPT" ] || grep -qF '{{' "$PROMPT" 2>/dev/null; then
    tick_say "SUPERVISE MISCONFIGURED $PROMPT is missing or unrendered — claude not launched (PHASE C renders it)"
    return 0
  fi
  # Read NOW, every tick: the allow-list may change during the night.
  if ! model=$(node "$REVIEWER_MODELS" --first 2>/dev/null); then
    tick_say "SUPERVISE MISCONFIGURED reviewer allow-list unreadable: $(printf '%s' "$model" | tr '\n' ' ') — claude not launched"
    return 0
  fi
  tick_want 'reviewer_models[0]' "$model" || return 0
  # Never unsandboxed, as triage_check: the project's settings (its deny list) passed explicitly.
  [ -d "$BASE" ] || { tick_say "SUPERVISE MISCONFIGURED BASE is not a directory: $BASE — claude not launched"; return 0; }
  [ -f "$settings" ] || { tick_say "SUPERVISE MISCONFIGURED settings file missing: $settings — claude not launched"; return 0; }
  mkdir -p "$TICK_DIR" "${TICKS_LOG%/*}" 2>/dev/null
  raw=$TICK_DIR/$(date +%s)-$$.jsonl
  # Backgrounded and waited for, like the sleep: a foreground tick would hold a trapped TERM/INT
  # until it ended (up to SUPERVISE_TICK_TIMEOUT); on_signal kills it instead.
  TICK_PIDF=${raw%.jsonl}.pid
  ( TICK_RC=""
    tick_launch "$NIGHT_DIR" "$SUPERVISE_TICK_TIMEOUT" "$TICK_WANT" "$raw" "$(cat "$PROMPT")" \
      --model "$model" --permission-mode bypassPermissions --settings "$settings"
    exit "${TICK_RC:-1}" ) 9>&- &
  TICK_BG=$!
  wait "$TICK_BG"
  TICK_RC=$?
  TICK_BG=""; TICK_PIDF=""
  say "tick exit=$TICK_RC" >>"$TICKS_LOG"
}

note "supervisor started (pid $$, interval ${SUPERVISE_INTERVAL}s, tick timeout ${SUPERVISE_TICK_TIMEOUT}s)"
while :; do
  sleep "$SUPERVISE_INTERVAL" 9>&- &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || :
  SLEEP_PID=""
  should_exit && break
  tick
done
cleanup
exit 0
