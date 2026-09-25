#!/usr/bin/env bash
# night-watch.sh — independent, zero-token watchdog for a /bajzi:night-run run.
#
# WHY IT IS BASH AND NOT CLAUDE
# The thing it most needs to notice is the account's 5-hour session limit. A
# Claude-based watcher would spend the very quota it watches and would go blind
# at the exact moment it is needed — so this file never calls the model, never
# calls the `claude` binary, and costs zero tokens.
#
# USAGE
#   night-watch.sh --config <path/to/config.env> [--once] [--interval <sec>]
#   NIGHT_CONFIG=<path> night-watch.sh
#     --config <path>   the same config.env run.sh reads (or NIGHT_CONFIG)
#     --once            run ONE tick, print one status line, exit (tests / humans)
#     --interval <sec>  override WATCH_INTERVAL for this process
#     -h | --help       this header
# run.sh spawns it detached with stdout/stderr appended to $NIGHT_DIR/watch.log.
#
# CONFIG KEYS (defaults when absent)
#   WATCH_INTERVAL=900      seconds between ticks; 0 disables the watcher (exit 0)
#   WATCH_MAX_RESTARTS=2    how many times a dead runner may be restarted
#   WATCH_NOTIFY_CMD=""     optional command, gets ONE argument: the message
#   WATCH_TRIAGE=1          tier 1: on every NEW terminal row in state.txt spawn ONE headless
#                           `claude -p` tick (model WATCH_TRIAGE_MODEL, bypassPermissions) with
#                           $NIGHT_DIR/WATCHER-BRIEF.md; 0 disables. Costs tokens only on events.
#   WATCH_TRIAGE_MODEL=claude-sonnet-5   WATCH_TRIAGE_ESCALATION_MODEL=<reviewer allow-list [0]>
#   DISK_FLOOR_GB           required, whole GB; below it the run is stopped
#   NIGHT_DIR, BASE, PROJECT   as in run.sh
#
# FILES IT READS under $NIGHT_DIR (all written by run.sh unless said otherwise)
#   run.flock    never unlinked; run.sh holds flock on it for the run's lifetime.
#                LIVENESS TEST: `flock -n` SUCCEEDS => no runner alive (the lock
#                is released again immediately — this is a probe, never a hold).
#   heartbeat    touched at least every 60 s while the runner lives (run.sh
#                beats in its story poll, its quota wait and once per queue
#                line); older than HEARTBEAT_STALL_SEC = STALLED
#   quota-until  epoch seconds: the EXACT moment launches may resume. run.sh has
#                already added QUOTA_MARGIN_SEC to the announced reset before
#                writing it, so this script adds NOTHING — it compares
#                quota-until > now. Adding the margin twice here is how a
#                one-off 3-minute grace silently became six.
#   run.meta     key=value: pgid started_epoch deadline_epoch run_date base
#                night_dir skill_dir config mode. ONLY a QUEUE run publishes
#                this file at all (--report and --smoke take the lock and
#                publish nothing), so mode is effectively always queue; the
#                mode gate below is belt-and-braces for a hand-started watcher
#                and for an older runner's leftovers, and a missing mode counts
#                as queue. started_epoch is a BARE EPOCH, written before this
#                script is spawned.
#                started_epoch DATES THE RUN. NIGHT_DIR is PERMANENT, so the
#                markers below survive the night that wrote them: every one
#                whose mtime is OLDER than started_epoch belongs to an earlier
#                night and is treated as ABSENT (logged once). No run.meta, or
#                no sane started_epoch => UNKNOWN and no restart: a watcher that
#                cannot date the markers must not act on them.
#   run.args     the runner's COMPLETE argv, one word per line, argv[0] (the
#                absolute path of run.sh) FIRST: a restart re-execs it verbatim
#                with `mapfile -t A <run.args; setsid "${A[@]}"`, never
#                <skill_dir>/run.sh plus those words — that doubled the path.
#   finished     epoch, written after the report when a non-dry run has ended.
#                IGNORED when older than started_epoch — otherwise, from the
#                second night on, the watcher read yesterday's marker two
#                seconds after being spawned, printed FINISHED and left the
#                runner unwatched until morning.
#   STOP         if present the runner stops before the next story; THIS SCRIPT
#                MAY CREATE IT (disk floor breach) and writes the reason into
#                it. run.sh NEVER deletes it, and dates it not at all — so the
#                watcher dates it against the EARLIER of started_epoch and its
#                OWN start: a restart rewrites started_epoch, and a STOP the
#                owner dropped in the seconds before that restart is older than
#                it yet plainly tonight's. Older than this watcher's own start
#                => an earlier night's, ignored.
#   state.txt    symlink to state-<run_date>.txt, rows `<id> <token> <ISO> [why]`
#                the LAST row of an id is its outcome; DEFERRED-* is NOT done
#   queue.txt    the queue run.sh walks: `id|slug|needs|note`, # comments
#   story/<id>.sid   session id of a launched story; `pgrep -s <sid>` = members
# FILES IT WRITES under $NIGHT_DIR
#   watch.pid  watch.status  watch.restarts  (and STOP, on a disk floor breach)
#   watch.restarts A CRASH HINT, NOT THE BUDGET. The budget is an in-memory
#     counter that lives as long as this watcher, which outlives every runner it
#     restarts. The file is read ONCE, at start, and only when it is newer than
#     started_epoch (else the count starts at 0); every restart writes it both
#     before and after the spawn, and it is never read again. It cannot be
#     authoritative: the restarted run.sh deletes it at queue start and writes a
#     fresh started_epoch seconds later, which would reset the count to 0 after
#     every restart and make the restarts unbounded.
#   logs/runner-restart-<n>.log   stdout+stderr of the n-th restarted runner
#
# ONE LINE PER TICK, on stdout:
#   <ISO UTC> <STATUS> runner=<alive|dead> hb=<age s> disk=<free G>
#   quota=<none|wait until <ISO>> queue=<done>/<total> deferred=<n> orphans=<n>
#
# STATUSES
#   OK         runner alive, heartbeat fresh, disk fine
#   STALLED    runner alive but the heartbeat is older than HEARTBEAT_STALL_SEC
#   QUOTA-WAIT quota-until is in the future — healthy, the runner is waiting
#   DISK-LOW   free disk under DISK_FLOOR_GB (or df unreadable): STOP created,
#              notified. NOTHING is ever deleted by this script.
#   RESTARTED  the runner was dead and has just been re-launched from run.args
#   DEAD       the runner is dead and the restart budget is spent — keeps
#              ticking, so the owner can fix it by hand and be seen recovering
#   FINISHED   `finished` exists — logs the summary and exits 0
#   STOPPED    STOP exists and the runner is dead — exits 0
#   EXPIRED    now > deadline_epoch + 1800 — exits 0
#   UNKNOWN    a check the watcher depends on failed: no flock, a broken pgrep,
#              or a run.meta that is missing or carries no usable started_epoch.
#              Fail-closed: never reported as OK, and nothing is restarted. An
#              unreadable df is NOT this — that is DISK-LOW, see above.
#
# NOTIFY happens on TRANSITIONS only (previous status kept in watch.status), and
# on each restart: `update-monitor note "night-run <project>: ..."` when
# update-monitor is on PATH, plus WATCH_NOTIFY_CMD "<message>" when set.
#
# ORPHANS are REPORTED, never signalled: the only process this script ever
# signals is the `sleep` slice it started itself, when it is signalled in turn.
# It only ever starts a runner (the restart), never stops one.
#
# MODE GATE: the watcher exits 0 at once unless run.meta says mode=queue (or
# carries no mode at all). A --report or --smoke run is short, foreground and
# nobody's night — it must never be restarted.

set -u

PROG=night-watch.sh
CONFIG=${NIGHT_CONFIG:-}
ONCE=0
INTERVAL_OVERRIDE=""

usage(){ sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --config)   [ $# -ge 2 ] || { echo "$PROG: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    --once)     ONCE=1;;
    --interval) [ $# -ge 2 ] || { echo "$PROG: --interval needs seconds" >&2; exit 2; }; INTERVAL_OVERRIDE=$2; shift;;
    -h|--help)  usage; exit 0;;
    *) echo "$PROG: unknown argument '$1' (see --help)" >&2; exit 2;;
  esac
  shift
done

[ -n "$CONFIG" ] || { echo "$PROG: no config — pass --config <path> or set NIGHT_CONFIG." >&2; exit 2; }
[ -f "$CONFIG" ] || { echo "$PROG: config file not found: $CONFIG" >&2; exit 2; }
# Same contract as run.sh: a plain sourced key=value file.
set -a
# shellcheck source=/dev/null
. "$CONFIG"
set +a

CONFIG_ABS=$(readlink -f "$CONFIG" 2>/dev/null) || CONFIG_ABS=""
[ -n "$CONFIG_ABS" ] || CONFIG_ABS=$CONFIG

NIGHT_DIR=${NIGHT_DIR:-}
BASE=${BASE:-}
PROJECT=${PROJECT:-}
DISK_FLOOR_GB=${DISK_FLOOR_GB:-}
WATCH_INTERVAL=${WATCH_INTERVAL:-900}
WATCH_MAX_RESTARTS=${WATCH_MAX_RESTARTS:-2}
WATCH_NOTIFY_CMD=${WATCH_NOTIFY_CMD:-}

[ -n "$NIGHT_DIR" ] || { echo "$PROG: $CONFIG has no NIGHT_DIR" >&2; exit 2; }
[ -d "$NIGHT_DIR" ] || { echo "$PROG: NIGHT_DIR does not exist: $NIGHT_DIR" >&2; exit 2; }
[ -n "$PROJECT" ] || PROJECT=${NIGHT_DIR##*/}
[ -n "$BASE" ] || BASE=$NIGHT_DIR
case "$DISK_FLOOR_GB" in
  ''|*[!0-9]*) echo "$PROG: DISK_FLOOR_GB must be a whole number of GB, got '${DISK_FLOOR_GB}'" >&2; exit 2;;
esac
case "$WATCH_INTERVAL"     in ''|*[!0-9]*) WATCH_INTERVAL=900;; esac
case "$WATCH_MAX_RESTARTS" in ''|*[!0-9]*) WATCH_MAX_RESTARTS=2;; esac
if [ -n "$INTERVAL_OVERRIDE" ]; then
  case "$INTERVAL_OVERRIDE" in ''|*[!0-9]*) echo "$PROG: --interval wants whole seconds" >&2; exit 2;; esac
  WATCH_INTERVAL=$INTERVAL_OVERRIDE
fi

# WATCH_INTERVAL=0 is the documented off switch. Say so, do nothing, leave 0.
if [ "$WATCH_INTERVAL" -eq 0 ] && [ $ONCE -eq 0 ]; then
  echo "$(date -u +%FT%TZ) $PROG: WATCH_INTERVAL=0 — watcher disabled, exiting."
  exit 0
fi

# THE HEARTBEAT CONTRACT, in one number. run.sh touches $NIGHT_DIR/heartbeat at
# least every 60 s while it lives: its story poll beats every <=20 s, its quota
# wait every <=60 s, its report-session poll every <=20 s, and once per queue
# line. Three missed beats — not one — is what counts as wedged, so a slow
# filesystem or a scheduling hiccup never fakes a STALLED.
HEARTBEAT_STALL_SEC=180

FLOCK_FILE=$NIGHT_DIR/run.flock
HEARTBEAT=$NIGHT_DIR/heartbeat
QUOTA_FILE=$NIGHT_DIR/quota-until
META=$NIGHT_DIR/run.meta
ARGS_FILE=$NIGHT_DIR/run.args
FINISHED=$NIGHT_DIR/finished
STOP=$NIGHT_DIR/STOP
STATE=$NIGHT_DIR/state.txt
QUEUE=$NIGHT_DIR/queue.txt
STORY_DIR=$NIGHT_DIR/story
LOGS=$NIGHT_DIR/logs
PIDFILE=$NIGHT_DIR/watch.pid
STATUS_FILE=$NIGHT_DIR/watch.status
RESTART_FILE=$NIGHT_DIR/watch.restarts

# WHEN THIS WATCHER STARTED. It is the second floor for the owner's STOP: see
# stop_floor() below. Read once, never again — it dates US, not the run.
WATCH_START=$(date +%s)

now_iso(){ date -u +%FT%TZ; }
say(){ printf '%s %s\n' "$(now_iso)" "$*"; }

# ---------------------------------------------------------- single watcher ---
# Two watchers on one NIGHT_DIR would double every restart. A stale pid file is
# not a reason to refuse: only a LIVE night-watch.sh is.
# BOTH halves are required. "cmdline CONTAINS night-watch.sh" is not a watcher:
# a renamed sleep, an editor or a grep matched it and blocked every new watcher
# on the machine. So: some argv element's BASENAME must be exactly night-watch.sh
# AND the process must name the same config (or the same NIGHT_DIR) as we do.
is_our_watcher(){ # pid -> 0 when pid is a live night-watch.sh watching THIS run
  local pid=$1 a named=0 same=0
  [ -r "/proc/$pid/cmdline" ] || return 1
  local argv=()
  mapfile -d '' -t argv <"/proc/$pid/cmdline" 2>/dev/null || return 1
  [ "${#argv[@]}" -gt 0 ] || return 1
  for a in "${argv[@]}"; do
    [ "${a##*/}" = "$PROG" ] && named=1
    case "$a" in "$CONFIG"|"$CONFIG_ABS"|"$NIGHT_DIR") same=1;; esac
  done
  # Started from NIGHT_CONFIG instead of --config: the env carries the same fact.
  if [ "$named" -eq 1 ] && [ "$same" -eq 0 ] && [ -r "/proc/$pid/environ" ]; then
    while IFS= read -r -d '' a; do
      case "$a" in
        NIGHT_CONFIG="$CONFIG"|NIGHT_CONFIG="$CONFIG_ABS"|NIGHT_DIR="$NIGHT_DIR") same=1; break;;
      esac
    done <"/proc/$pid/environ"
  fi
  [ "$named" -eq 1 ] && [ "$same" -eq 1 ]
}
if [ -f "$PIDFILE" ]; then
  other=$(head -1 "$PIDFILE" 2>/dev/null | tr -dc '0-9')
  if [ -n "$other" ] && [ "$other" != "$$" ]; then
    if is_our_watcher "$other"; then
      say "another $PROG is already watching $NIGHT_DIR (pid $other) — exiting."
      exit 0
    fi
    say "$PIDFILE holds pid $other, which is not a live $PROG for this run — taking it over."
  fi
fi
printf '%s\n' "$$" >"$PIDFILE" 2>/dev/null || say "WARNING: could not write $PIDFILE"

# The current sleep slice runs as a CHILD, so a TERM can be acted on at once
# instead of up to 60 s later; on_signal kills that child (the only process this
# script ever signals is one it started itself).
SLEEP_PID=""

# shellcheck disable=SC2317  # both run from traps
cleanup(){
  local mine
  if [ -f "$PIDFILE" ]; then
    mine=$(head -1 "$PIDFILE" 2>/dev/null | tr -dc '0-9')
    [ "$mine" = "$$" ] && rm -f "$PIDFILE"
  fi
}
# shellcheck disable=SC2317  # runs from the INT/TERM trap
on_signal(){
  say "$PROG: signalled — stopping."
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  cleanup
  exit 0
}
trap on_signal INT TERM
trap cleanup EXIT

# ------------------------------------------------------------- the checks ---
HAVE_FLOCK=1
command -v flock >/dev/null 2>&1 || HAVE_FLOCK=0

# 0 = a runner holds the lock (ALIVE), 1 = nobody holds it (DEAD), 2 = cannot tell
probe_runner(){
  [ "$HAVE_FLOCK" -eq 1 ] || return 2
  [ -e "$FLOCK_FILE" ] || return 1
  local rc
  exec 9<>"$FLOCK_FILE" || return 2
  # NOT `if flock -n 9; then ...; fi; rc=$?` — an `if` with no `else` returns 0
  # when its condition FAILS, which turned every live runner into UNKNOWN.
  flock -n 9; rc=$?
  if [ "$rc" -eq 0 ]; then
    flock -u 9          # we only probed — never hold the runner's lock
    exec 9>&-
    return 1
  fi
  exec 9>&-
  [ "$rc" -eq 1 ] && return 0
  return 2
}

# free GB on a path, or empty + rc 1 when df cannot read it (NOT an all-clear)
free_gb_of(){
  local p=$1 out
  [ -n "$p" ] || return 1
  out=$(df -BG --output=avail "$p" 2>/dev/null) || return 1
  out=$(printf '%s\n' "$out" | tail -1 | tr -dc '0-9')
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

meta_get(){ # key -> value, empty when absent
  [ -f "$META" ] || return 0
  sed -n "s/^$1=//p" "$META" 2>/dev/null | tail -1
}

# ------------------------------------------------------------ which mode? ---
# BELT AND BRACES, and unreachable in a normal night. run.sh publishes run.args
# and run.meta ONLY from a queue run — `--report` and `--smoke` take the lock
# and publish nothing — so a run.meta found here effectively always says
# mode=queue. The gate stays for the two cases that are not a normal night: a
# human starting this script by hand next to a report or smoke run, and a
# run.meta left by an OLDER runner that did publish one. Restarting either from
# run.args would re-run a report nobody asked for. A run.meta with no mode=
# line is an older runner: it can only have been a queue run, so it is watched.
RUN_MODE=$(meta_get mode | tr -dc '[:lower:]')
if [ -n "$RUN_MODE" ] && [ "$RUN_MODE" != queue ]; then
  say "$PROG: run.meta says mode=$RUN_MODE (not queue) — a $RUN_MODE run needs no watchdog. Exiting."
  cleanup
  exit 0
fi

# ------------------------------------------------ which NIGHT is this one? ---
# NIGHT_DIR is the project's PERMANENT directory, so last night's finished, STOP
# and watch.restarts are still lying in it when tonight's runner starts. Without
# dating them the watcher printed FINISHED two seconds after being spawned and
# the runner ran unwatched all night, and a spent restart budget disarmed every
# following night. run.sh deletes those markers at queue start; this is the
# second belt, and the only one that also covers STOP.
iso_of(){ date -u -d "@$1" +%FT%TZ 2>/dev/null || printf '%s' "$1"; }

RUN_START=""
RUN_START_WHY=""
read_run_start(){ # 0 = RUN_START is a usable epoch, 1 = this run cannot be dated
  local raw v now_s
  RUN_START=""; RUN_START_WHY=""
  if [ ! -f "$META" ]; then
    RUN_START_WHY="$META is missing — this run cannot be dated, so tonight's markers cannot be told from an older night's"
    return 1
  fi
  raw=$(meta_get started_epoch)
  v=$(printf '%s' "$raw" | tr -dc '0-9')
  now_s=$(date +%s)
  # A SANE epoch only: an ISO timestamp squeezed through `tr -dc 0-9` becomes a
  # 14-digit number that would make every marker look stale for ever.
  if [ -z "$v" ] || [ "$v" -lt 1000000000 ] || [ "$v" -gt $((now_s + 86400)) ]; then
    RUN_START_WHY="$META has no usable started_epoch (got '$raw')"
    return 1
  fi
  RUN_START=$v
  return 0
}

STALE_SEEN=""
# 0 = the marker is at or after <floor> (or cannot be dated at all: fail
# closed), 1 = absent, or older than <floor> and therefore an earlier night's.
marker_since(){ # path label floor
  local f=$1 label=$2 floor=$3 m
  [ -e "$f" ] || return 1
  [ -n "$floor" ] || return 0
  m=$(stat -c %Y "$f" 2>/dev/null | tr -dc '0-9')
  [ -n "$m" ] || return 0
  [ "$m" -ge "$floor" ] && return 0
  case " $STALE_SEEN " in
    *" $label "*) :;;
    *) STALE_SEEN="$STALE_SEEN $label"
       say "ignoring stale $label from $(iso_of "$m") (floor $(iso_of "$floor"))";;
  esac
  return 1
}
marker_of_this_run(){ marker_since "$1" "$2" "$RUN_START"; }

# STOP IS DATED MORE GENEROUSLY THAN THE REST, against the EARLIER of this
# watcher's own start and the run's started_epoch. A RESTART rewrites
# started_epoch, so a STOP the owner dropped in the seconds between the old
# runner's death and the restart is OLDER than the new started_epoch — and the
# restarted run.sh honours it (it only tests for the file) while the watcher
# would have called it yesterday's and restarted the night again. Anything
# older than this watcher's own start is still an earlier night's: we were not
# running when it was written.
stop_floor(){
  [ -n "$RUN_START" ] || { printf '%s' "$WATCH_START"; return 0; }
  if [ "$WATCH_START" -lt "$RUN_START" ]; then printf '%s' "$WATCH_START"
  else printf '%s' "$RUN_START"; fi
}
stop_is_live(){ marker_since "$STOP" STOP "$(stop_floor)"; }

state_file(){ # the real state file, empty when state.txt is missing or dangling
  [ -e "$STATE" ] || return 0
  printf '%s\n' "$STATE"
}

notify(){ # message
  local msg=$1
  if command -v update-monitor >/dev/null 2>&1; then
    update-monitor note "$msg" >/dev/null 2>&1 \
      || say "WARNING: update-monitor note failed"
  fi
  if [ -n "$WATCH_NOTIFY_CMD" ]; then
    "$WATCH_NOTIFY_CMD" "$msg" >/dev/null 2>&1 \
      || say "WARNING: WATCH_NOTIFY_CMD failed: $WATCH_NOTIFY_CMD"
  fi
}

maybe_notify(){ # status detail — only when the status CHANGED
  local st=$1 detail=$2 prev=""
  [ -f "$STATUS_FILE" ] && prev=$(head -1 "$STATUS_FILE" 2>/dev/null)
  if [ "$st" != "$prev" ]; then
    notify "night-run $PROJECT: $st — $detail"
  fi
  printf '%s\n' "$st" >"$STATUS_FILE" 2>/dev/null || true
}

# ------------------------------------------------------ tier 1: triage ---
# Tier 0 (this script) never calls the model. Tier 1 does, but ONLY on an event: a NEW terminal row
# in state.txt since the last check. One headless tick per event, detached, 10 min cap, logged to
# $NIGHT_DIR/triage.log. The brief is rendered by the skill (PHASE C) into $NIGHT_DIR/WATCHER-BRIEF.md;
# without it, or with WATCH_TRIAGE=0, this is a no-op.
WATCH_TRIAGE=${WATCH_TRIAGE:-1}
WATCH_TRIAGE_MODEL=${WATCH_TRIAGE_MODEL:-claude-sonnet-5}
TRIAGE_BRIEF=$NIGHT_DIR/WATCHER-BRIEF.md
TRIAGE_LOG=$NIGHT_DIR/triage.log
TRIAGE_SEEN=0
triage_check(){
  [ "$WATCH_TRIAGE" = "1" ] || return 0
  [ -f "$TRIAGE_BRIEF" ] || return 0
  local sf; sf=$(state_file); [ -n "$sf" ] || return 0
  local n; n=$(wc -l <"$sf" 2>/dev/null || echo 0)
  [ "$n" -gt "$TRIAGE_SEEN" ] || return 0
  local new; new=$(tail -n "$((n - TRIAGE_SEEN))" "$sf")
  TRIAGE_SEEN=$n
  command -v claude >/dev/null 2>&1 || { say "TRIAGE skipped: claude not on PATH"; return 0; }
  local facts
  facts=$(printf 'runner.log tail:\n%s\nstate.txt tail:\n%s\nwatch status: %s\n' \
    "$(tail -n 15 "$NIGHT_DIR/logs/runner.log" 2>/dev/null)" "$(tail -n 10 "$sf")" "$(head -1 "$STATUS_FILE" 2>/dev/null)")
  # awk, not sed: the event and the facts hold newlines and arbitrary characters.
  local prompt
  prompt=$(awk -v ev="new terminal rows in state.txt:
$new" -v fa="$facts" '{ gsub(/\{\{EVENT\}\}/, ev); gsub(/\{\{FACTS\}\}/, fa); print }' "$TRIAGE_BRIEF")
  say "TRIAGE tick: $(printf '%s' "$new" | tr '\n' ';')"
  ( printf '%s' "$prompt" | timeout 600 claude -p --model "$WATCH_TRIAGE_MODEL" --permission-mode bypassPermissions \
      --output-format text >>"$TRIAGE_LOG" 2>&1 || say "TRIAGE tick exited $?" ) 9>&- &
}

# THE RESTART BUDGET IS AN IN-MEMORY COUNTER, and this watcher's own memory is
# the only authority for it. The watcher outlives every runner it restarts (a
# second watcher spawned by a restarted runner exits on the single-instance
# guard above), so nothing else has to survive.
# $RESTART_FILE is a CRASH HINT ONLY. It cannot be the source of truth: the
# restarted run.sh deletes it at queue start — together with `finished` —
# seconds after the spawn, AND writes a fresh started_epoch that would date any
# surviving copy as an earlier night's. Re-reading it per tick therefore reset
# the count to 0 after every restart, WATCH_MAX_RESTARTS was never reached and
# the restarts were unbounded. So: read it ONCE at start (and only when it is
# newer than started_epoch), then never again.
RESTARTS=0
init_restart_budget(){
  local n=""
  read_run_start || :
  if marker_since "$RESTART_FILE" watch.restarts "$RUN_START"; then
    n=$(head -1 "$RESTART_FILE" 2>/dev/null | tr -dc '0-9')
  fi
  [ -n "$n" ] || n=0
  RESTARTS=$n
  [ "$RESTARTS" -gt 0 ] && say "restart budget resumed from $RESTART_FILE: $RESTARTS/$WATCH_MAX_RESTARTS already used"
  return 0
}
restarts_so_far(){ printf '%s\n' "$RESTARTS"; }

# run.args is the COMPLETE argv of the run, argv[0] first, so the restart is
# `setsid "${A[@]}"` — verbatim. Prefixing it with <skill_dir>/run.sh once more
# handed the runner its own path as $1 and every restart died on
# "unknown argument". The only thing checked here is that argv[0] really is an
# executable file; which script it is, is the runner's business, not ours.
do_restart(){ # n
  local n=$1 log
  [ -s "$ARGS_FILE" ] || { say "ERROR: $ARGS_FILE is missing or empty — cannot restart"; return 1; }
  local A=()
  mapfile -t A <"$ARGS_FILE" || { say "ERROR: could not read $ARGS_FILE"; return 1; }
  [ "${#A[@]}" -gt 0 ] || { say "ERROR: $ARGS_FILE holds no argv — cannot restart"; return 1; }
  if [ ! -f "${A[0]}" ] || [ ! -x "${A[0]}" ]; then
    say "ERROR: argv[0] of $ARGS_FILE is not an executable file: '${A[0]}' — cannot restart"
    return 1
  fi
  mkdir -p "$LOGS" 2>/dev/null || true
  log=$LOGS/runner-restart-$n.log
  say "RESTART $n/$WATCH_MAX_RESTARTS — re-exec of the argv in $ARGS_FILE: ${A[*]}, log $log"
  # The counter is ours; the FILE is written BEFORE the spawn so that a watcher
  # killed mid-restart still leaves the hint behind, and again afterwards
  # because the restarted runner may have cleared it in between. Neither write
  # is ever read back by THIS watcher.
  RESTARTS=$n
  printf '%s\n' "$n" >"$RESTART_FILE" 2>/dev/null || say "WARNING: could not write $RESTART_FILE"
  # 9>&- belongs here even though probe_runner always closes fd 9: flock(2)
  # lives on the open file description, so a single inherited copy would keep
  # the OLD run's lock alive and the restarted runner would refuse with exit 3.
  setsid "${A[@]}" </dev/null >>"$log" 2>&1 9>&- &
  printf '%s\n' "$n" >"$RESTART_FILE" 2>/dev/null || :
  notify "night-run $PROJECT: RESTART $n/$WATCH_MAX_RESTARTS — runner was dead, relaunched from run.args"
  return 0
}

# --------------------------------------------------------------- one tick ---
# Sets TICK_EXIT=1 when the watcher is done (FINISHED / STOPPED / EXPIRED).
TICK_EXIT=0
tick(){
  local now status detail runner hb_txt disk_txt quota_txt orphans
  now=$(date +%s)
  status=OK
  detail=""
  TICK_EXIT=0
  local unknown=0 unknown_why=""

  # 0. WHICH NIGHT? ----------------------------------------------------------
  # Re-read every tick: a restarted runner writes a NEW run.meta, and from then
  # on the markers are dated against the new start.
  local meta_bad=0
  if ! read_run_start; then
    meta_bad=1; unknown=1; unknown_why="$RUN_START_WHY"
  fi

  # 1. RUNNER ---------------------------------------------------------------
  local rc_runner
  probe_runner; rc_runner=$?
  case $rc_runner in
    0) runner=alive;;
    1) runner=dead;;
    *) runner=dead; unknown=1
       if [ "$HAVE_FLOCK" -eq 0 ]; then unknown_why="flock is not installed — runner liveness cannot be tested"
       else unknown_why="the flock probe on $FLOCK_FILE failed"; fi;;
  esac

  local hb_age=-1
  if [ -f "$HEARTBEAT" ]; then
    local hb_m
    hb_m=$(stat -c %Y "$HEARTBEAT" 2>/dev/null | tr -dc '0-9')
    if [ -n "$hb_m" ]; then hb_age=$((now - hb_m)); fi
  fi
  if [ "$hb_age" -ge 0 ]; then hb_txt=$hb_age; else hb_txt="-"; fi

  # 2. DISK -----------------------------------------------------------------
  local g_base g_night disk_free="" disk_bad=0
  g_base=$(free_gb_of "$BASE") || g_base=""
  g_night=$(free_gb_of "$NIGHT_DIR") || g_night=""
  if [ -z "$g_base" ] || [ -z "$g_night" ]; then
    disk_bad=1; disk_txt="?"
  else
    if [ "$g_base" -le "$g_night" ]; then disk_free=$g_base; else disk_free=$g_night; fi
    disk_txt="${disk_free}G"
    [ "$disk_free" -lt "$DISK_FLOOR_GB" ] && disk_bad=1
  fi

  # 3. QUOTA ----------------------------------------------------------------
  local quota_until="" quota_waiting=0
  if [ -f "$QUOTA_FILE" ]; then
    quota_until=$(head -1 "$QUOTA_FILE" 2>/dev/null | tr -dc '0-9')
  fi
  # quota-until is the EXACT moment launches may resume: run.sh already added
  # QUOTA_MARGIN_SEC to the announced reset before writing the file. Adding the
  # margin again here would hold the watcher in QUOTA-WAIT past the moment the
  # runner is free to work, so the comparison is plain `> now`.
  if [ -n "$quota_until" ] && [ "$quota_until" -gt "$now" ]; then
    quota_waiting=1
    quota_txt="wait until $(date -u -d "@$quota_until" +%FT%TZ 2>/dev/null || printf '%s' "$quota_until")"
  else
    quota_txt="none"
  fi

  # queue accounting --------------------------------------------------------
  local total=0 done_n=0 deferred_n=0 sf last_tok=""
  if [ -f "$QUEUE" ]; then
    total=$(awk -F'|' '{ id=$1; gsub(/^[ \t]+|[ \t]+$/,"",id); if (id=="" || id ~ /^#/) next; n++ } END{ print n+0 }' "$QUEUE" 2>/dev/null)
    case "$total" in ''|*[!0-9]*) total=0;; esac
  fi
  sf=$(state_file)
  if [ -n "$sf" ] && [ -r "$sf" ]; then
    local counts
    counts=$(awk 'NF>=2 { last[$1]=$2 } END { d=0; f=0; for (i in last) { if (last[i] ~ /^DEFERRED-/) f++; else d++ } print d" "f }' "$sf" 2>/dev/null)
    done_n=${counts%% *}; deferred_n=${counts##* }
    case "$done_n"     in ''|*[!0-9]*) done_n=0;; esac
    case "$deferred_n" in ''|*[!0-9]*) deferred_n=0;; esac
    last_tok=$(awk 'NF>=2 { t=$2 } END { print t }' "$sf" 2>/dev/null)
  fi

  # 4. ORPHANS — counted and named, NEVER signalled -------------------------
  orphans=0
  local orphan_lines=""
  if [ -d "$STORY_DIR" ]; then
    local sidf
    for sidf in "$STORY_DIR"/*.sid; do
      [ -f "$sidf" ] || continue
      local sid story pids prc story_last terminal
      sid=$(head -1 "$sidf" 2>/dev/null | tr -dc '0-9')
      [ -n "$sid" ] || continue
      story=${sidf##*/}; story=${story%.sid}
      pids=$(pgrep -s "$sid" 2>/dev/null); prc=$?
      if [ "$prc" -gt 1 ]; then
        unknown=1; unknown_why="pgrep -s $sid failed (rc=$prc) — orphan check is blind"
        continue
      fi
      [ -n "$pids" ] || continue
      terminal=0
      if [ -n "$sf" ] && [ -r "$sf" ]; then
        story_last=$(awk -v id="$story" '$1==id && NF>=2 { t=$2 } END { print t }' "$sf" 2>/dev/null)
        if [ -n "$story_last" ]; then
          case "$story_last" in DEFERRED-*) terminal=0;; *) terminal=1;; esac
        fi
      fi
      if [ "$terminal" -eq 1 ] || [ "$runner" = dead ]; then
        orphans=$((orphans + 1))
        orphan_lines="${orphan_lines}orphan sid=$sid story=$story pids=$(printf '%s' "$pids" | tr '\n' ',' | sed 's/,$//')"$'\n'
      fi
    done
  fi

  # deadline ----------------------------------------------------------------
  local deadline
  deadline=$(meta_get deadline_epoch | tr -dc '0-9')

  # ------------------------------------------------------------- verdict ---
  # Order matters: an ended run is an ended run, a full disk outranks
  # everything that is still running, and a quota wait is NOT a dead runner.
  local exiting=0
  # Dated ONCE per tick, before the chain: an undatable run (meta_bad) trusts
  # neither marker, so it falls through to UNKNOWN instead of ending the watch.
  local fin_here=0 stop_here=0
  marker_of_this_run "$FINISHED" finished && fin_here=1
  stop_is_live && stop_here=1
  if [ "$meta_bad" -eq 0 ] && [ "$fin_here" -eq 1 ]; then
    status=FINISHED
    detail="run finished, queue $done_n/$total done, $deferred_n deferred"
    exiting=1
  elif [ "$meta_bad" -eq 0 ] && [ "$stop_here" -eq 1 ] && [ "$runner" = dead ]; then
    status=STOPPED
    detail="STOP present and the runner is gone: $(head -1 "$STOP" 2>/dev/null)"
    exiting=1
  elif [ "$meta_bad" -eq 0 ] && [ -n "$deadline" ] && [ "$now" -gt $((deadline + 1800)) ]; then
    status=EXPIRED
    detail="past deadline_epoch+1800 with no finished marker"
    exiting=1
  elif [ "$disk_bad" -eq 1 ]; then
    status=DISK-LOW
    if [ "$disk_txt" = "?" ]; then
      detail="df could not read $BASE or $NIGHT_DIR — treated as NOT enough disk"
    else
      detail="free disk ${disk_txt} is below DISK_FLOOR_GB=${DISK_FLOOR_GB}G"
    fi
    if [ "$stop_here" -eq 0 ]; then
      printf 'night-watch %s: %s — the runner must stop before the next story. Nothing was deleted.\n' \
        "$(now_iso)" "$detail" >"$STOP" 2>/dev/null \
        || say "ERROR: could not create $STOP"
      say "created $STOP — $detail"
    fi
  elif [ "$unknown" -eq 1 ]; then
    status=UNKNOWN
    detail="$unknown_why"
    say "ERROR: $unknown_why"
  elif [ "$runner" = alive ] && [ "$hb_age" -ge 0 ] && [ "$hb_age" -gt "$HEARTBEAT_STALL_SEC" ]; then
    status=STALLED
    detail="runner holds the lock but the heartbeat is ${hb_age}s old (limit ${HEARTBEAT_STALL_SEC}s = 3 x the 60s contract)"
  elif [ "$quota_waiting" -eq 1 ]; then
    status=QUOTA-WAIT
    detail="waiting for the account limit to reset, $quota_txt"
  elif [ "$runner" = dead ]; then
    case "$last_tok" in
      DEFERRED-quota*) say "the runner died during a quota wait (last state row: $last_tok)";;
    esac
    local n max
    n=$(restarts_so_far); max=$WATCH_MAX_RESTARTS
    if [ -n "$deadline" ] && [ "$now" -ge $((deadline - 600)) ]; then
      status=DEAD
      detail="runner dead with under 10 min to the deadline — not restarting"
    elif [ "$n" -lt "$max" ]; then
      if do_restart $((n + 1)); then
        status=RESTARTED
        detail="runner was dead, restarted $((n + 1))/$max"
      else
        status=DEAD
        detail="runner dead and the restart could not be performed — see the ERROR above"
      fi
    else
      status=DEAD
      detail="runner dead, $n/$max restarts already used — waiting for the owner"
    fi
  else
    status=OK
    detail="runner alive, heartbeat ${hb_txt}s, free disk ${disk_txt}"
  fi

  printf '%s %s runner=%s hb=%s disk=%s quota=%s queue=%s/%s deferred=%s orphans=%s\n' \
    "$(now_iso)" "$status" "$runner" "$hb_txt" "$disk_txt" "$quota_txt" \
    "$done_n" "$total" "$deferred_n" "$orphans"
  [ -n "$orphan_lines" ] && printf '%s' "$orphan_lines"

  maybe_notify "$status" "$detail"

  if [ "$exiting" -eq 1 ]; then
    say "$status — $detail. Watcher exiting."
    TICK_EXIT=1
  fi
  return 0
}

# ------------------------------------------------------------------ loop ---
say "$PROG: watching $NIGHT_DIR (project=$PROJECT interval=${WATCH_INTERVAL}s max_restarts=$WATCH_MAX_RESTARTS floor=${DISK_FLOOR_GB}G once=$ONCE)"
init_restart_budget

tick
triage_check
if [ $ONCE -eq 1 ] || [ "$TICK_EXIT" -eq 1 ]; then
  cleanup
  exit 0
fi

while :; do
  # Sleep in <=60 s slices so a STOP or a finished marker is noticed promptly
  # instead of up to WATCH_INTERVAL late — and each slice is a CHILD we `wait`
  # on, so an INT/TERM is acted on within milliseconds instead of at the end of
  # the slice: `sleep 60` in the foreground made watch.pid linger for a minute
  # after the run was stopped.
  slept=0
  while [ "$slept" -lt "$WATCH_INTERVAL" ]; do
    left=$((WATCH_INTERVAL - slept))
    [ "$left" -gt 60 ] && left=60
    sleep "$left" 9>&- &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || :
    SLEEP_PID=""
    slept=$((slept + left))
    # An EARLIER night's finished/STOP must not spin this loop, so the same
    # dating rule applies here as in the verdict.
    if marker_of_this_run "$FINISHED" finished || stop_is_live; then break; fi
  done
  tick
  [ "$TICK_EXIT" -eq 1 ] && break
done

cleanup
exit 0
