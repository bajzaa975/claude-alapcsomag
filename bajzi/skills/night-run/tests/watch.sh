#!/usr/bin/env bash
# tests/watch.sh — night-watch.sh scenarios, no run.sh, no claude, no model.
#
# Every scenario builds its OWN throwaway NIGHT_DIR, config.env and queue under
# one scratch tree, runs `night-watch.sh --once`, and greps the single status
# line. The only processes it starts are its own `flock` holders and its own
# run.sh STUB — nothing else is ever signalled, and the real `update-monitor`
# is shadowed by a stub on PATH so a test run never writes to the machine
# journal.
#
# This file does NOT source tests/lib.sh: it needs no fake claude, no git base
# and no night runner at all. It shares only the scratch CONVENTION with the
# other three — everything it creates lives under $NR_SCRATCH.
#
#   bash tests/watch.sh        # PASS/FAIL per scenario, non-zero on any FAIL
#   NR_SCRATCH=/some/dir bash tests/watch.sh

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WATCH=$HERE/../night-watch.sh
[ -x "$WATCH" ] || { echo "FAIL: $WATCH is not executable"; exit 1; }

NR_SCRATCH=${NR_SCRATCH:-${TMPDIR:-/tmp}/night-run-tests}
mkdir -p "$NR_SCRATCH" || exit 1
WT=$(mktemp -d "$NR_SCRATCH/watch.XXXXXX") || exit 1
FAILED=0
HOLDERS=""

# ---------------------------------------------------------------- helpers ---
# A stub update-monitor, so the tests never touch the real journal.
mkdir -p "$WT/bin"
cat >"$WT/bin/update-monitor" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${UM_LOG:-/dev/null}"
EOS
chmod +x "$WT/bin/update-monitor"

# A stub run.sh: it records the argv it was restarted with and exits at once.
mkdir -p "$WT/skill"
cat >"$WT/skill/run.sh" <<EOS
#!/usr/bin/env bash
printf 'RAN %s\n' "\$*" >>"$WT/stub.calls"
EOS
chmod +x "$WT/skill/run.sh"

ok(){   printf 'PASS  %s\n' "$*"; }
bad(){  printf 'FAIL  %s\n' "$*"; FAILED=1; }
check(){ # name expected-substring actual
  case "$3" in *"$2"*) ok "$1";; *) bad "$1 — expected '$2' in: $3";; esac
}

mkenv(){ # name [floor] -> echoes the NIGHT_DIR
  local name=$1 floor=${2:-1} nd=$WT/$1
  mkdir -p "$nd/base" "$nd/logs" "$nd/story"
  cat >"$nd/config.env" <<EOS
PROJECT="watchtest-$name"
NIGHT_DIR="$nd"
BASE="$nd/base"
DISK_FLOOR_GB="$floor"
WATCH_INTERVAL="900"
WATCH_MAX_RESTARTS="2"
EOS
  printf 's1|slug-one|-|criteria\ns2|slug-two|-|criteria\n# a comment\n\n' >"$nd/queue.txt"
  printf 's1 0 2026-09-18T01:00:00Z\n' >"$nd/state-2026-09-18.txt"
  ln -sf "state-2026-09-18.txt" "$nd/state.txt"
  printf '%s\n' \
    "pgid=1" \
    "started_epoch=$(date +%s)" \
    "deadline_epoch=$(( $(date +%s) + 36000 ))" \
    "run_date=2026-09-18" \
    "base=$nd/base" \
    "night_dir=$nd" \
    "skill_dir=$WT/skill" \
    "config=$nd/config.env" \
    "mode=${MODE:-queue}" >"$nd/run.meta"
  # run.args is the COMPLETE argv the runner was started with: argv[0] FIRST.
  # The watcher re-execs it verbatim, so the stub must receive exactly the
  # original arguments — never its own path as $1.
  printf '%s\n' "$WT/skill/run.sh" "--config" "$nd/config.env" "--deadline" "04:30" >"$nd/run.args"
  : >"$nd/run.flock"
  printf '%s\n' "$nd"
}

hold(){ # NIGHT_DIR — take the runner's flock in the background, like run.sh does
  local nd=$1
  rm -f "$nd/holder.ready"
  # The holder EXECs into its sleep, so $! stays the pid that owns fd 9 and one
  # kill both releases the lock and leaves nothing behind. `flock -c "...; sleep"`
  # forked the sleep off instead: killing $! released the lock but left a stray
  # sleep running for two minutes, holding this script's stdout open with it.
  bash -c '
     exec 9<>"$1/run.flock" || exit 1
     flock -w 10 9 || exit 1
     touch "$1/holder.ready"
     exec sleep 120' _ "$nd" </dev/null >/dev/null 2>&1 &
  HOLDERS="$HOLDERS $!"
  local i=0
  while [ ! -f "$nd/holder.ready" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
}

# The watcher's own exit status propagates, so callers do:
#   OUT=$(run_watch "$ND"); RC=$?
run_watch(){ # NIGHT_DIR [extra args...] -> stdout
  local nd=$1; shift
  PATH="$WT/bin:$PATH" UM_LOG="$WT/um.log" "$WATCH" --config "$nd/config.env" --once "$@" 2>&1
}
RC=0

# ------------------------------------------------------------ 1. healthy ----
ND=$(mkenv healthy); hold "$ND"; touch "$ND/heartbeat"
OUT=$(run_watch "$ND"); RC=$?
check "1 healthy: OK + runner alive" " OK runner=alive" "$OUT"

# ------------------------------------------------------------ 2. stalled ----
ND=$(mkenv stalled); hold "$ND"
touch -d "@$(( $(date +%s) - 300 ))" "$ND/heartbeat"
OUT=$(run_watch "$ND"); RC=$?
check "2 stale heartbeat: STALLED" " STALLED runner=alive" "$OUT"

# ------------------------------------------------- 3+4. restart, then DEAD --
ND=$(mkenv restart); touch "$ND/heartbeat"; : >"$WT/stub.calls"
OUT=$(run_watch "$ND"); RC=$?
check "3 dead runner: RESTART 1/2" "RESTART 1/2" "$OUT"
# --once is a whole PROCESS: its in-memory budget dies with it, so the next
# invocation may only carry on from the FILE — and does, because the file is
# newer than started_epoch. This is the one case watch.restarts is read in.
N=$(head -1 "$ND/watch.restarts" 2>/dev/null)
if [ "$N" = 1 ]; then ok "3 watch.restarts holds the crash hint 1"; else bad "3 expected watch.restarts=1, got '$N'"; fi
i=0; while [ ! -s "$WT/stub.calls" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
CALLS=$(cat "$WT/stub.calls" 2>/dev/null)
check "3 stub ran with the run.args argv" "RAN --config $ND/config.env --deadline 04:30" "$CALLS"
OUT=$(run_watch "$ND"); RC=$?
check "4 second --once process resumes from the hint: RESTART 2/2" "RESTART 2/2" "$OUT"
check "4 …and says where the count came from" "restart budget resumed from" "$OUT"
i=0; while [ "$(/usr/bin/grep -c '^RAN ' "$WT/stub.calls")" -lt 2 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
OUT=$(run_watch "$ND"); RC=$?
check "4 third tick: DEAD, budget spent" " DEAD runner=dead" "$OUT"
sleep 0.5
N=$(/usr/bin/grep -c '^RAN ' "$WT/stub.calls")
if [ "$N" = 2 ]; then ok "4 exactly 2 restarts, no third"; else bad "4 expected 2 stub calls, got $N"; fi

# ------------------------------------------------------------- 5. quota -----
# quota-until is the EXACT moment launches may resume — run.sh has ALREADY
# added QUOTA_MARGIN_SEC to the announced reset before writing it. So a big
# QUOTA_MARGIN_SEC in config.env must change nothing here: the watcher compares
# quota-until with now and adds no second margin.
ND=$(mkenv quota); touch "$ND/heartbeat"; : >"$WT/stub.calls"
printf 'QUOTA_MARGIN_SEC="600"\n' >>"$ND/config.env"
printf '%s\n' "$(( $(date +%s) + 3600 ))" >"$ND/quota-until"
OUT=$(run_watch "$ND"); RC=$?
check "5 quota wait: QUOTA-WAIT" " QUOTA-WAIT runner=dead" "$OUT"
sleep 0.3
if [ -s "$WT/stub.calls" ]; then bad "5 a restart happened during a quota wait"; else ok "5 no restart during a quota wait"; fi
# 60 s PAST the reset, with a 600 s margin in config.env: the wait is over.
printf '%s\n' "$(( $(date +%s) - 60 ))" >"$ND/quota-until"
OUT=$(run_watch "$ND"); RC=$?
check "5 past quota-until: no second margin" " quota=none" "$OUT"
case "$OUT" in *QUOTA-WAIT*) bad "5 QUOTA_MARGIN_SEC was added a second time";; *) ok "5 QUOTA_MARGIN_SEC is not applied twice";; esac

# -------------------------------------------------------------- 6. disk -----
ND=$(mkenv disk 999999); touch "$ND/heartbeat"
OUT=$(run_watch "$ND"); RC=$?
check "6 floor breached: DISK-LOW" " DISK-LOW " "$OUT"
if [ -f "$ND/STOP" ]; then
  ok "6 STOP created with a reason: $(head -1 "$ND/STOP" | cut -c1-40)..."
else
  bad "6 STOP was not created"
fi

# ---------------------------------------------------------- 7. finished -----
ND=$(mkenv finished); touch "$ND/heartbeat"
printf '%s\n' "$(date +%s)" >"$ND/finished"
OUT=$(run_watch "$ND"); RC=$?
check "7 finished marker: FINISHED" " FINISHED " "$OUT"
if [ "$RC" = 0 ]; then ok "7 exit 0 on FINISHED"; else bad "7 expected exit 0, got $RC"; fi

# ------------------------------------------------------------ 8. notify -----
ND=$(mkenv notify); hold "$ND"; touch "$ND/heartbeat"
cat >"$WT/notify.sh" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\$1" >>"$WT/notify.log"
EOS
chmod +x "$WT/notify.sh"
printf 'WATCH_NOTIFY_CMD="%s"\n' "$WT/notify.sh" >>"$ND/config.env"
: >"$WT/notify.log"
run_watch "$ND" >/dev/null
touch "$ND/heartbeat"
run_watch "$ND" >/dev/null
N=$(wc -l <"$WT/notify.log")
if [ "$N" = 1 ]; then ok "8 two identical OK ticks notify once"; else bad "8 expected 1 notify line, got $N: $(cat "$WT/notify.log")"; fi
touch -d "@$(( $(date +%s) - 300 ))" "$ND/heartbeat"
run_watch "$ND" >/dev/null
N=$(wc -l <"$WT/notify.log")
if [ "$N" = 2 ]; then ok "8 a status change notifies again"; else bad "8 expected 2 notify lines, got $N: $(cat "$WT/notify.log")"; fi

# ----------------------------------------------------------- 9. mode gate ---
# BELT AND BRACES, and unreachable in a normal night: only a queue run publishes
# run.meta at all, so a real one always says mode=queue. The gate exists for the
# two cases that are not a normal night — a watcher started by hand next to a
# --report or --smoke run, and a run.meta left by an OLDER runner that did
# publish one for those modes. Either way it must leave at once, because
# restarting from run.args would re-run a report nobody asked for.
: >"$WT/stub.calls"
ND=$(MODE=report mkenv modereport); touch "$ND/heartbeat"
OUT=$(run_watch "$ND"); RC=$?
check "9 mode=report: watcher declines" "mode=report (not queue)" "$OUT"
if [ "$RC" = 0 ]; then ok "9 exit 0 on a non-queue mode"; else bad "9 expected exit 0, got $RC"; fi
sleep 0.3
if [ -s "$WT/stub.calls" ]; then bad "9 a report run was restarted"; else ok "9 no restart for a report run"; fi
case "$OUT" in *" runner="*) bad "9 the mode gate ticked instead of exiting";; *) ok "9 the mode gate exits before the first tick";; esac

# ------------------------------------------ 10. a SECOND night in the same dir ---
# NIGHT_DIR is the project's PERMANENT directory: last night's finished, STOP and
# watch.restarts are still lying in it when tonight's runner starts. Everything
# older than run.meta's started_epoch must be treated as absent, or the watcher
# prints FINISHED two seconds after being spawned and the runner is unwatched all
# night — and yesterday's spent restart budget disarms tonight's first restart.
: >"$WT/stub.calls"
ND=$(mkenv second-night)
touch "$ND/heartbeat"
YDAY=$(( $(date +%s) - 86400 ))
printf '%s\n' "$YDAY"   >"$ND/finished";       touch -d "@$YDAY" "$ND/finished"
printf '2\n'            >"$ND/watch.restarts"; touch -d "@$YDAY" "$ND/watch.restarts"
printf 'yesterday\n'    >"$ND/STOP";           touch -d "@$YDAY" "$ND/STOP"
OUT=$(run_watch "$ND"); RC=$?
check "10 stale finished+STOP+restarts: RESTART 1/2" "RESTART 1/2" "$OUT"
check "10 the stale marker is logged" "ignoring stale finished from" "$OUT"
case "$OUT" in *FINISHED*) bad "10 yesterday's finished ended tonight's watch";; *) ok "10 no FINISHED from yesterday's marker";; esac
case "$OUT" in *STOPPED*) bad "10 yesterday's STOP stopped tonight's watch";; *) ok "10 no STOPPED from yesterday's marker";; esac
i=0; while [ ! -s "$WT/stub.calls" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
N=$(head -1 "$ND/watch.restarts" 2>/dev/null)
if [ "$N" = 1 ]; then ok "10 watch.restarts overwritten with 1"; else bad "10 expected watch.restarts=1, got '$N'"; fi

# ------------------------------- 11. tonight's OWN finished still ends the watch ---
touch "$ND/finished"        # mtime now => newer than started_epoch
OUT=$(run_watch "$ND"); RC=$?
check "11 fresh finished: FINISHED" " FINISHED " "$OUT"
if [ "$RC" = 0 ]; then ok "11 exit 0 on a fresh finished"; else bad "11 expected exit 0, got $RC"; fi

# --------------------------------- 12. tonight's OWN STOP still stops the watch ---
ND=$(mkenv fresh-stop); touch "$ND/heartbeat"; : >"$WT/stub.calls"
printf 'kill switch\n' >"$ND/STOP"
OUT=$(run_watch "$ND"); RC=$?
check "12 fresh STOP + dead runner: STOPPED" " STOPPED " "$OUT"
sleep 0.3
if [ -s "$WT/stub.calls" ]; then bad "12 a stopped run was restarted"; else ok "12 no restart after a fresh STOP"; fi

# ------------------------------------------- 13. an undatable run = fail closed ---
# No run.meta (or no sane started_epoch) means the watcher cannot tell tonight's
# markers from an older night's. It says UNKNOWN and restarts NOTHING.
ND=$(mkenv nometa); touch "$ND/heartbeat"; : >"$WT/stub.calls"
rm -f "$ND/run.meta"
OUT=$(run_watch "$ND"); RC=$?
check "13 no run.meta: UNKNOWN" " UNKNOWN " "$OUT"
sleep 0.3
if [ -s "$WT/stub.calls" ]; then bad "13 restarted a run it cannot date"; else ok "13 no restart without run.meta"; fi
# An ISO timestamp in started_epoch squeezed through tr -dc digits becomes a huge
# number that would make EVERY marker look stale for ever: it is not an epoch.
printf 'mode=queue\nstarted_epoch=2026-09-18T01:00:00Z\n' >"$ND/run.meta"
OUT=$(run_watch "$ND"); RC=$?
check "13 unusable started_epoch: UNKNOWN" " UNKNOWN " "$OUT"

# ------------------------------------------ 14. DEFERRED-* is never counted done ---
# run.sh adds tokens over time (DEFERRED-needs, -quota, -quota-weekly, -alive):
# the counting is PREFIX based, so a new one needs no change here.
ND=$(mkenv deferred-alive); hold "$ND"; touch "$ND/heartbeat"
printf '%s\n' \
  "s1 DEFERRED-alive 2026-09-18T01:00:00Z previous session still alive" \
  "s2 0 2026-09-18T02:00:00Z" >"$ND/state-2026-09-18.txt"
OUT=$(run_watch "$ND")
check "14 DEFERRED-alive counts as not done" " queue=1/2 deferred=1" "$OUT"

# --------------------------- 15. single-instance guard + a TERM that lands fast ---
# The guard must look at WHAT the pid is, not at a substring: a process merely
# NAMED night-watch.sh, watching some other run, once blocked every new watcher.
ND=$(mkenv guard); hold "$ND"; touch "$ND/heartbeat"
( exec -a night-watch.sh sleep 300 ) &
DECOY=$!
printf '%s\n' "$DECOY" >"$ND/watch.pid"
OUT=$(run_watch "$ND"); RC=$?
check "15 a same-named process on another run does not block" " OK runner=alive" "$OUT"
case "$OUT" in *"already watching"*) bad "15 the decoy blocked a real watcher";; *) ok "15 the decoy is treated as a stale pid";; esac
kill "$DECOY" 2>/dev/null; wait "$DECOY" 2>/dev/null

# A REAL second watcher on the SAME config must decline, quietly, with exit 0.
rm -f "$ND/watch.pid"
PATH="$WT/bin:$PATH" UM_LOG="$WT/um.log" "$WATCH" --config "$ND/config.env" --interval 120 >"$WT/guard.log" 2>&1 &
W1=$!
# Wait for W1's OWN pid in the file — any leftover would make this a race.
i=0; while [ "$(head -1 "$ND/watch.pid" 2>/dev/null)" != "$W1" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
OUT=$(run_watch "$ND"); RC=$?
check "15 a real second watcher on the same config declines" "already watching" "$OUT"
if [ "$RC" = 0 ]; then ok "15 exit 0 when another watcher owns the dir"; else bad "15 expected exit 0, got $RC"; fi

# The TERM trap must not wait out the current 60 s sleep slice.
T0=$(date +%s)
kill -TERM "$W1" 2>/dev/null
i=0; while kill -0 "$W1" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
wait "$W1" 2>/dev/null
ELAPSED=$(( $(date +%s) - T0 ))
if kill -0 "$W1" 2>/dev/null; then bad "15 the watcher ignored TERM"
elif [ "$ELAPSED" -le 3 ]; then ok "15 TERM stops the watcher in ${ELAPSED}s (sleep is interruptible)"
else bad "15 TERM took ${ELAPSED}s — the sleep slice is not interruptible"; fi
if [ -f "$ND/watch.pid" ]; then bad "15 watch.pid survived the TERM"; else ok "15 watch.pid removed on TERM"; fi

# ------------------ 16. the budget survives the runner the watcher restarts ---
# A LIVE watcher against a runner that behaves like the real one: the restarted
# run.sh DELETES watch.restarts at queue start and republishes run.meta with a
# fresh started_epoch, seconds after the spawn. Re-reading the file per tick
# therefore counted 0 again after every restart — WATCH_MAX_RESTARTS was never
# reached and the restarts were unbounded. The count is the WATCHER'S OWN, so
# exactly two restarts happen and the third tick says DEAD.
ND=$(mkenv budget); touch "$ND/heartbeat"
: >"$WT/stub2.calls"
cat >"$WT/skill/run-clear.sh" <<EOS
#!/usr/bin/env bash
printf 'RAN %s\n' "\$*" >>"$WT/stub2.calls"
rm -f "$ND/watch.restarts"
now=\$(date +%s)
{ printf 'pgid=1\n'
  printf 'started_epoch=%s\n' "\$now"
  printf 'deadline_epoch=%s\n' "\$(( now + 36000 ))"
  printf 'run_date=2026-09-18\nbase=$ND/base\nnight_dir=$ND\nskill_dir=$WT/skill\nconfig=$ND/config.env\nmode=queue\n'
} >"$ND/run.meta"
EOS
chmod +x "$WT/skill/run-clear.sh"
printf '%s\n' "$WT/skill/run-clear.sh" "--config" "$ND/config.env" >"$ND/run.args"
PATH="$WT/bin:$PATH" UM_LOG="$WT/um.log" "$WATCH" --config "$ND/config.env" --interval 2 >"$WT/budget.log" 2>&1 &
W2=$!
i=0; while ! /usr/bin/grep -q " DEAD runner=dead" "$WT/budget.log" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done
kill -TERM "$W2" 2>/dev/null; wait "$W2" 2>/dev/null
BUD=$(cat "$WT/budget.log")
check "16 live watcher: RESTART 1/2" "RESTART 1/2" "$BUD"
check "16 live watcher: RESTART 2/2" "RESTART 2/2" "$BUD"
check "16 then the budget is spent: DEAD" " DEAD runner=dead" "$BUD"
N=$(/usr/bin/grep -c "^RAN " "$WT/stub2.calls")
if [ "$N" = 2 ]; then ok "16 exactly 2 restarts although the runner cleared watch.restarts"
else bad "16 expected 2 restarts, got $N (the budget reset after a restart)"; fi

# -------------- 17. a STOP dropped just before a RESTART still stops the run ---
# The restarted runner writes a NEW started_epoch, so a STOP the owner placed in
# the seconds before that restart is OLDER than it — and run.sh honours it (it
# only tests for the file) while the watcher, dating everything against
# started_epoch alone, called it yesterday's and kept restarting the night. STOP
# is therefore dated against the EARLIER of started_epoch and the watcher's own
# start. (The runner's own half of this is tests/lock-race.sh (vi): a pre-placed
# STOP survives the start of the run and stops the night before the first story.)
ND=$(mkenv stop-after-restart); touch "$ND/heartbeat"
printf 'WATCH_MAX_RESTARTS="0"\n' >>"$ND/config.env"   # no restarts: this is about STOP
T0=$(date +%s)
PATH="$WT/bin:$PATH" UM_LOG="$WT/um.log" "$WATCH" --config "$ND/config.env" --interval 2 >"$WT/stopafter.log" 2>&1 &
W3=$!
i=0; while ! /usr/bin/grep -q " DEAD runner=dead" "$WT/stopafter.log" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done
sleep 6                                    # so that now-5 is after this watcher started
NOWS=$(date +%s)
sed -i "s/^started_epoch=.*/started_epoch=$NOWS/" "$ND/run.meta"   # the restarted runner
printf 'owner stop\n' >"$ND/STOP"; touch -d "@$(( NOWS - 5 ))" "$ND/STOP"
SM=$(stat -c %Y "$ND/STOP")
if [ "$SM" -lt "$NOWS" ] && [ "$SM" -ge "$T0" ]; then
  ok "17 precondition: STOP is older than started_epoch and newer than the watcher's start"
else
  bad "17 precondition failed: STOP=$SM started_epoch=$NOWS watcher_start=$T0"
fi
i=0; while kill -0 "$W3" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done
if kill -0 "$W3" 2>/dev/null; then
  bad "17 the watcher ignored a STOP older than started_epoch"
  kill -TERM "$W3" 2>/dev/null; wait "$W3" 2>/dev/null
else
  wait "$W3"; RC=$?
  SA=$(cat "$WT/stopafter.log")
  check "17 STOP across a restart: STOPPED" " STOPPED " "$SA"
  if [ "$RC" = 0 ]; then ok "17 exit 0 on STOPPED"; else bad "17 expected exit 0, got $RC"; fi
  case "$SA" in *"ignoring stale STOP"*) bad "17 the STOP was treated as an earlier night's";; *) ok "17 the STOP was not called stale";; esac
fi

# ------------------------------------------------------------- teardown -----
for p in $HOLDERS; do kill "$p" 2>/dev/null; done
sleep 0.5
for p in $HOLDERS; do kill -9 "$p" 2>/dev/null; done
sleep 0.3
for p in $HOLDERS; do
  if kill -0 "$p" 2>/dev/null; then bad "teardown: flock holder $p survived"; fi
done
LEFT=$(/usr/bin/pgrep -f "$WT" 2>/dev/null | /usr/bin/grep -v "^$$\$")
if [ -n "$LEFT" ]; then
  bad "teardown: processes left behind under $WT: $(printf '%s' "$LEFT" | tr '\n' ' ')"
else
  ok "teardown: no processes left under the scratch tree"
fi
rm -rf "$WT"

if [ $FAILED -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAILED
