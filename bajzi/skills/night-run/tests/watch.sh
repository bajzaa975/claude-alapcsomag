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
  flock "$nd/run.flock" -c "touch '$nd/holder.ready'; sleep 120" &
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
i=0; while [ ! -s "$WT/stub.calls" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
CALLS=$(cat "$WT/stub.calls" 2>/dev/null)
check "3 stub ran with the run.args argv" "RAN --config $ND/config.env --deadline 04:30" "$CALLS"
OUT=$(run_watch "$ND"); RC=$?
check "4 second tick: RESTART 2/2" "RESTART 2/2" "$OUT"
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
# A --report or --smoke run must never be restarted: the watcher reads
# run.meta's mode and leaves at once for anything that is not a queue run.
: >"$WT/stub.calls"
ND=$(MODE=report mkenv modereport); touch "$ND/heartbeat"
OUT=$(run_watch "$ND"); RC=$?
check "9 mode=report: watcher declines" "mode=report (not queue)" "$OUT"
if [ "$RC" = 0 ]; then ok "9 exit 0 on a non-queue mode"; else bad "9 expected exit 0, got $RC"; fi
sleep 0.3
if [ -s "$WT/stub.calls" ]; then bad "9 a report run was restarted"; else ok "9 no restart for a report run"; fi
case "$OUT" in *" runner="*) bad "9 the mode gate ticked instead of exiting";; *) ok "9 the mode gate exits before the first tick";; esac

# ------------------------------------------------------------- teardown -----
for p in $HOLDERS; do kill "$p" 2>/dev/null; done
sleep 0.5
for p in $HOLDERS; do kill -9 "$p" 2>/dev/null; done
sleep 0.3
LEFT=$(/usr/bin/pgrep -f "$WT" 2>/dev/null | /usr/bin/grep -v "^$$\$")
if [ -n "$LEFT" ]; then
  bad "teardown: processes left behind under $WT: $(printf '%s' "$LEFT" | tr '\n' ' ')"
else
  ok "teardown: no processes left under the scratch tree"
fi
rm -rf "$WT"

if [ $FAILED -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAILED
