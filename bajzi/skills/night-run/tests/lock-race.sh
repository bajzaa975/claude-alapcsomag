#!/usr/bin/env bash
# Proves the RUN LOCK. Three checks, no framework, no real claude, no process
# signalled that this script did not start.
#
#   (i)   40 trials of two runners started simultaneously against ONE night dir
#         that already holds a STALE run.lock. Exactly one may run the story;
#         the other must exit 3. The old check-then-act lock lost this 9 times
#         in 40: both runners read the same dead pgid, both decided the lock
#         was stale, and the second `rm -f` deleted the winner's live lock.
#   (ii)  a runner KILLed outright (SIGKILL, so no trap runs) leaves run.flock
#         unlocked, because the kernel — not the runner — releases it. A new
#         runner takes it within a second, with no stale state to judge.
#   (iii) fd 9, the run lock, is not inherited by the session the runner
#         launches. An orphaned claude holding it would lock the project out.
#   (v)   nor by the `sleep` of the post-acquire retry loop, which a decoy
#         runner with the same --config keeps the real runner in.
#   (vi)  `finished` and `watch.restarts` are night-scoped and owned by the
#         QUEUE run: it clears yesterday's copies at the start and writes
#         `finished` only at the end. A pre-placed STOP is the owner's and
#         survives; `--report` publishes nothing to the watcher at all.
#
# Usage:  bash tests/lock-race.sh [trials]
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

TRIALS=${1:-40}
BATCH=8
ROOT=$NR_SCRATCH/lock-race
rm -rf "$ROOT"; mkdir -p "$ROOT"
BASE=$NR_SCRATCH/shared-base
nr_make_base "$BASE" || { echo "FAIL could not create the fixture BASE worktree"; exit 1; }
DEADPID=$(nr_dead_pid)

# ----------------------------------------------------------------- (i) race --
trial(){ # n
  local n=$1 R nd gate cfg p1 p2 r1 r2 starts
  R=$ROOT/t$n; nd=$R/nd; cfg=$R/cfg.env; gate=$R/gate
  mkdir -p "$R"
  nr_make_night "$nd"
  nr_queue "$nd" S1
  nr_fake_claude "$R/fake-claude" "$nd/fake"
  nr_plan "$nd/fake" "ok:3" "ok"
  nr_config "$cfg" "$nd" "$BASE" "$R/fake-claude"
  # THE fixture: a lock left behind by a runner that is long dead. Both
  # starters see it, both can prove the pgid is gone, and exactly one of them
  # is still allowed to run the night.
  printf '%s\n' "$DEADPID" >"$nd/run.lock"
  # Both runners wait on the same gate file, so they enter acquire_lock within
  # a few milliseconds of each other. `setsid` gives each its own pgid, the way
  # the runner is really launched.
  ( while [ ! -e "$gate" ]; do sleep 0.01; done; exec setsid -w bash "$NR_RUN" --config "$cfg" ) >"$R/o1" 2>&1 &
  p1=$!
  ( while [ ! -e "$gate" ]; do sleep 0.01; done; exec setsid -w bash "$NR_RUN" --config "$cfg" ) >"$R/o2" 2>&1 &
  p2=$!
  sleep 0.3; : >"$gate"
  wait "$p1"; r1=$?
  wait "$p2"; r2=$?
  starts=$(grep -c ' START S1 (' "$nd/logs/runner.log" 2>/dev/null); starts=${starts:-0}
  printf 'starts=%s rc=%s,%s\n' "$starts" "$r1" "$r2" >"$R/result"
}

echo "== (i) $TRIALS two-runner races against one night dir with a stale run.lock =="
n=1
while [ "$n" -le "$TRIALS" ]; do
  b=0
  while [ "$b" -lt "$BATCH" ] && [ "$n" -le "$TRIALS" ]; do
    trial "$n" &
    n=$((n + 1)); b=$((b + 1))
  done
  wait
done

winners=0; bad_trials=""
t=1
while [ "$t" -le "$TRIALS" ]; do
  res=$(cat "$ROOT/t$t/result" 2>/dev/null || echo "starts=? rc=?,?")
  starts=${res#starts=}; starts=${starts%% *}
  rcs=${res##*rc=}
  case "$starts,$rcs" in
    "1,0,3"|"1,3,0") winners=$((winners + 1));;
    *) bad_trials="$bad_trials t$t($res)";;
  esac
  t=$((t + 1))
done
printf 'single winner in %d/%d trials\n' "$winners" "$TRIALS"
[ -n "$bad_trials" ] && printf 'trials that did NOT have exactly one winner:%s\n' "$bad_trials"
check "$([ "$winners" -eq "$TRIALS" ] && echo 0 || echo 1)" \
      "(i) exactly one runner ran the story and the other exited 3 — $winners/$TRIALS"

# --------------------------------------------------- (ii) kill -9 the runner --
echo
echo "== (ii) a SIGKILLed runner leaves run.flock unlocked =="
K=$ROOT/kill; mkdir -p "$K"
nd=$K/nd; cfg=$K/cfg.env
nr_make_night "$nd"
nr_queue "$nd" H1
nr_fake_claude "$K/fake-claude" "$nd/fake"
nr_plan "$nd/fake" "hang:20" "ok" "ok"
nr_config "$cfg" "$nd" "$BASE" "$K/fake-claude"
setsid -w bash "$NR_RUN" --config "$cfg" >"$K/o1" 2>&1 &
victim=$!
waited=0
while [ ! -s "$nd/story/H1.sid" ] && [ "$waited" -lt 200 ]; do sleep 0.05; waited=$((waited + 1)); done
check "$([ -s "$nd/story/H1.sid" ] && echo 0 || echo 1)" "(ii) the runner launched the story and wrote story/H1.sid"
# Signalling is allowed here and only here: this script started that runner.
kill -KILL "$victim" 2>/dev/null
wait "$victim" 2>/dev/null
before=$(grep -c 'run lock taken' "$nd/logs/runner.log" 2>/dev/null); before=${before:-0}
t0=$(date +%s%N)
setsid -w bash "$NR_RUN" --config "$cfg" --one NOSUCHSTORY >"$K/o2" 2>&1 &
second=$!
took=""
waited=0
while [ "$waited" -lt 300 ]; do
  now=$(grep -c 'run lock taken' "$nd/logs/runner.log" 2>/dev/null); now=${now:-0}
  if [ "$now" -gt "$before" ]; then took=$(( ( $(date +%s%N) - t0 ) / 1000000 )); break; fi
  sleep 0.02; waited=$((waited + 1))
done
wait "$second" 2>/dev/null; second_rc=$?
if [ -n "$took" ]; then
  printf 'the second runner took the lock in %s ms (exit %s)\n' "$took" "$second_rc"
  check "$([ "$took" -le 1000 ] && echo 0 || echo 1)" "(ii) a new runner acquired run.flock within 1000 ms — ${took} ms"
else
  printf 'the second runner never logged "run lock taken" (exit %s)\n' "$second_rc"
  check 1 "(ii) a new runner acquired run.flock within 1000 ms"
fi
check "$([ -f "$nd/run.flock" ] && echo 0 || echo 1)" "(ii) run.flock still exists — it is never unlinked"
nr_cleanup "$nd"

# ------------------------------------------------- (iv) per-story liveness ---
echo
echo "== (iv) the story's SESSION is what the runner tracks, not a wrapper pid =="
L=$ROOT/live; mkdir -p "$L"
lnd=$L/nd; lcfg=$L/cfg.env
nr_make_night "$lnd"
nr_queue "$lnd" L1 L2 L3
nr_fake_claude "$L/fake-claude" "$lnd/fake"
# L1 runs long enough to be inspected, L2 fails plainly, L3 leaves an orphan.
nr_plan "$lnd/fake" "ok:4" "raw:a plain failure with no limit message" "orphan:25" "ok"
nr_config "$lcfg" "$lnd" "$BASE" "$L/fake-claude"
setsid -w bash "$NR_RUN" --config "$lcfg" >"$L/out.txt" 2>&1 &
runner=$!
members=0; waited=0
while [ "$waited" -lt 300 ]; do
  if [ -s "$lnd/story/L1.sid" ]; then
    sid=$(tr -dc '0-9' <"$lnd/story/L1.sid")
    members=$(pgrep -s "$sid" 2>/dev/null | wc -l)
    [ "$members" -gt 0 ] && break
  fi
  sleep 0.05; waited=$((waited + 1))
done
printf 'story L1 sid=%s has %s session member(s) while it runs
' "${sid:-none}" "$members"
check "$([ "$members" -gt 0 ] && echo 0 || echo 1)" "(iv) pgrep -s <recorded sid> lists the story's session members"
wait "$runner" 2>/dev/null
lstate=$(cat "$lnd"/state-*.txt 2>/dev/null)
printf 'state rows:\n%s\n' "$lstate"
check "$(printf '%s\n' "$lstate" | grep -qE '^L1 0 ' && echo 0 || echo 1)" "(iv) wait returned L1's exit code (0)"
check "$(printf '%s\n' "$lstate" | grep -qE '^L2 1 ' && echo 0 || echo 1)" "(iv) wait returned L2's exit code (1), and a plain failure is NOT a quota row"
check "$(grep -q 'DRAIN L3: session .* still has' "$lnd/logs/runner.log" && echo 0 || echo 1)"       "(iv) the runner drained L3's session after wait returned"
l3sid=$(tr -dc '0-9' <"$lnd/story/L3.sid" 2>/dev/null)
left=$(pgrep -s "${l3sid:-0}" 2>/dev/null | wc -l)
printf 'L3 sid=%s has %s member(s) left after the run\n' "${l3sid:-none}" "$left"
check "$([ "$left" -eq 0 ] && echo 0 || echo 1)" "(iv) nothing from L3's session survived the run"

# A story whose recorded session is STILL ALIVE is never launched again. The
# session below is one this script started, so it is ours to create and remove.
setsid -w sleep 25 >/dev/null 2>&1 &
alive=$!
rm -f "$lnd"/state-*.txt "$lnd/state.txt" "$lnd/finished"
nr_queue "$lnd" L1
printf '%s\n' "$alive" >"$lnd/story/L1.sid"
: >"$lnd/logs/runner.log"
setsid -w bash "$NR_RUN" --config "$lcfg" >"$L/out2.txt" 2>&1
check "$(grep -q "SKIP L1 — previous session $alive still alive" "$lnd/logs/runner.log" && echo 0 || echo 1)" \
      "(iv) a story whose previous session is alive is SKIPped, not relaunched"
check "$(grep -q ' START L1 (' "$lnd/logs/runner.log" && echo 1 || echo 0)" "(iv) …and no second session was launched for it"
# A SKIP is not a silent drop: the story gets a NON-TERMINAL DEFERRED-alive row
# naming the session that blocked it, so the morning report can account for the
# queue line and a later pass (or the next night) can still pick it up.
srow=$(awk '$1=="L1"' "$lnd"/state-*.txt 2>/dev/null | tail -1)
printf 'L1 row after the skip: %s\n' "${srow:-<none>}"
check "$(printf '%s' "$srow" | grep -qE "^L1 DEFERRED-alive .* sid=$alive\$" && echo 0 || echo 1)" \
      "(iv) …and the skip recorded a DEFERRED-alive row naming the live session"
kill -TERM "$alive" 2>/dev/null; wait "$alive" 2>/dev/null
nr_cleanup "$lnd"

# ------------------------------ (v) fd 9 in the post-acquire retry loop -------
echo
echo "== (v) the sleep of the post-acquire retry loop does not hold fd 9 either =="
DY=$ROOT/decoy; mkdir -p "$DY/skill"
dnd=$DY/nd; dcfg=$DY/cfg.env
nr_make_night "$dnd"
nr_queue "$dnd" D1
nr_fake_claude "$DY/fake-claude" "$dnd/fake"
nr_plan "$dnd/fake" "ok" "ok"
nr_config "$dcfg" "$dnd" "$BASE" "$DY/fake-claude"
# THE fixture: a DECOY runner. Its argv[1] basenames to run.sh and carries the
# SAME --config, so the real runner's others_here() counts it and spins in the
# retry loop — holding fd 9, the run lock — instead of walking the queue. It
# never opens run.flock, so the real runner still gets the lock. It is a plain
# sleep this script started, so this script may wait for it.
cat >"$DY/skill/run.sh" <<'DECOY'
#!/usr/bin/env bash
# A decoy "runner": it only has to LOOK like one in /proc/<pid>/cmdline.
sleep 6
DECOY
setsid -w bash "$DY/skill/run.sh" --config "$dcfg" >/dev/null 2>&1 &
decoy=$!
setsid -w bash "$NR_RUN" --config "$dcfg" >"$DY/out.txt" 2>&1 &
drunner=$!
# Every `sleep` whose PARENT is the real runner, sampled while it waits the
# decoy out. fd 9 on any of them is the leak: flock(2) lives on the open file
# description, so a child that inherited it keeps the project locked.
samples=0; leaked=0; i=0
while [ "$i" -lt 120 ]; do
  for sp in $(pgrep -x sleep 2>/dev/null); do
    st=$(cat "/proc/$sp/stat" 2>/dev/null) || continue
    st=${st#*") "}
    # shellcheck disable=SC2086
    set -- $st
    pcmd=$(tr '\0' ' ' <"/proc/$2/cmdline" 2>/dev/null)
    case "$pcmd" in *"$NR_RUN"*"$dcfg"*) :;; *) continue;; esac
    samples=$((samples + 1))
    [ -e "/proc/$sp/fd/9" ] && leaked=$((leaked + 1))
  done
  sleep 0.05; i=$((i + 1))
done
printf 'sampled %s sleep(s) of the waiting runner, %s of them still held fd 9\n' "$samples" "$leaked"
check "$([ "$samples" -gt 0 ] && echo 0 || echo 1)" "(v) the runner really spun in the post-acquire retry loop"
check "$([ "$leaked" -eq 0 ] && echo 0 || echo 1)" "(v) no sleep in that loop inherited fd 9 ($leaked of $samples)"
wait "$decoy" 2>/dev/null
wait "$drunner" 2>/dev/null
check "$(grep -qE '^D1 0 ' "$dnd"/state-*.txt 2>/dev/null && echo 0 || echo 1)" "(v) …and the run went on to do the story once the decoy was gone"
nr_cleanup "$dnd"

# ------------------------- (vi) the night files the QUEUE run owns ------------
echo
echo "== (vi) a queue run clears last night's 'finished' and watch.restarts, and --report publishes nothing =="
OW=$ROOT/own; mkdir -p "$OW"
ond=$OW/nd; ocfg=$OW/cfg.env
nr_make_night "$ond"
nr_queue "$ond" V1
nr_fake_claude "$OW/fake-claude" "$ond/fake"
nr_plan "$ond/fake" "ok:6" "ok" "ok"
nr_config "$ocfg" "$ond" "$BASE" "$OW/fake-claude"
# Yesterday's leftovers. `finished` would tell tonight's watcher the run has
# already ended; watch.restarts would tell it its budget is spent.
printf '%s\n' "$(( $(date +%s) - 86400 ))" >"$ond/finished"
printf '2\n' >"$ond/watch.restarts"
setsid -w bash "$NR_RUN" --config "$ocfg" >"$OW/out.txt" 2>&1 &
orunner=$!
cleared=""; waited=0
while [ "$waited" -lt 200 ]; do
  if [ -s "$ond/story/V1.sid" ]; then
    cleared="finished=$([ -e "$ond/finished" ] && echo present || echo gone) restarts=$([ -e "$ond/watch.restarts" ] && echo present || echo gone)"
    break
  fi
  sleep 0.05; waited=$((waited + 1))
done
printf 'while the story ran: %s\n' "${cleared:-<the story never started>}"
check "$([ "$cleared" = "finished=gone restarts=gone" ] && echo 0 || echo 1)" \
      "(vi) both night-scoped files were removed when the queue run took the night"
wait "$orunner" 2>/dev/null
check "$([ -s "$ond/finished" ] && echo 0 || echo 1)" "(vi) 'finished' reappeared as the last act of the run"
# A STOP placed by the owner is NOT ours to clear: it must still stop the night.
printf 'owner asked for a stop\n' >"$ond/STOP"
rm -f "$ond"/state-*.txt "$ond/state.txt"
: >"$ond/logs/runner.log"
setsid -w bash "$NR_RUN" --config "$ocfg" >"$OW/out-stop.txt" 2>&1
check "$([ -f "$ond/STOP" ] && echo 0 || echo 1)" "(vi) a pre-placed STOP survived the start of the run"
check "$(grep -q 'STOP file present' "$ond/logs/runner.log" && echo 0 || echo 1)" "(vi) …and it stopped the night before the first story"
rm -f "$ond/STOP"
# --report takes the lock, but it is NOT the night: it must not republish the
# watcher's inputs or write 'finished', or a watcher polling a DEAD queue run
# reads mode=report and gives up on it.
a_before=$(md5sum <"$ond/run.args"); m_before=$(md5sum <"$ond/run.meta"); f_before=$(stat -c %Y "$ond/finished")
setsid -w bash "$NR_RUN" --config "$ocfg" --report >"$OW/out-report.txt" 2>&1; rc_rep=$?
a_after=$(md5sum <"$ond/run.args"); m_after=$(md5sum <"$ond/run.meta"); f_after=$(stat -c %Y "$ond/finished")
printf 'report mode exited %s; run.args %s run.meta %s finished mtime %s -> %s\n' "$rc_rep" \
  "$([ "$a_before" = "$a_after" ] && echo same || echo CHANGED)" \
  "$([ "$m_before" = "$m_after" ] && echo same || echo CHANGED)" "$f_before" "$f_after"
check "$([ "$a_before" = "$a_after" ] && echo 0 || echo 1)" "(vi) --report left run.args byte-identical"
check "$([ "$m_before" = "$m_after" ] && echo 0 || echo 1)" "(vi) --report left run.meta byte-identical"
check "$([ "$f_before" = "$f_after" ] && echo 0 || echo 1)" "(vi) --report did not rewrite 'finished'"
check "$(grep -q '^mode=queue' "$ond/run.meta" && echo 0 || echo 1)" "(vi) run.meta still says mode=queue"
# --smoke follows the same rule, and its session is backgrounded and polled, so
# the heartbeat keeps ticking through it (it used to run up to 360 s in the
# foreground without a single beat).
rm -f "$ond/heartbeat"
nr_plan "$ond/fake" "ok:3" "ok"
setsid -w bash "$NR_RUN" --config "$ocfg" --smoke >"$OW/out-smoke.txt" 2>&1; rc_sm=$?
s_args=$(md5sum <"$ond/run.args"); s_meta=$(md5sum <"$ond/run.meta"); s_fin=$(stat -c %Y "$ond/finished")
printf 'smoke mode exited %s; heartbeat %s\n' "$rc_sm" "$([ -f "$ond/heartbeat" ] && echo written || echo MISSING)"
check "$([ "$rc_sm" -eq 0 ] && echo 0 || echo 1)" "(vi) --smoke ran its session and exited 0"
check "$([ "$a_after" = "$s_args" ] && [ "$m_after" = "$s_meta" ] && [ "$f_after" = "$s_fin" ] && echo 0 || echo 1)" \
      "(vi) --smoke published nothing either (run.args, run.meta and finished untouched)"
check "$([ -f "$ond/heartbeat" ] && echo 0 || echo 1)" "(vi) …and it beat while its session ran"
nr_cleanup "$ond"

# ------------------------------------------------------------- (iii) fd leak --
echo
echo "== (iii) fd 9 (the run lock) is not inherited by the session =="
leaks=0; seen=0
for f in "$ROOT"/t*/nd/fake/fds.log "$nd/fake/fds.log" "$ROOT"/live/nd/fake/fds.log \
         "$ROOT"/decoy/nd/fake/fds.log "$ROOT"/own/nd/fake/fds.log; do
  [ -s "$f" ] || continue
  seen=$((seen + 1))
  c=$(grep -c ' 9 -> ' "$f" 2>/dev/null); c=${c:-0}
  leaks=$((leaks + c))
done
printf 'inspected %d fake-claude fd tables, %d of them had an fd 9\n' "$seen" "$leaks"
check "$([ "$seen" -gt 0 ] && echo 0 || echo 1)" "(iii) the fake claude really ran and recorded its fd table ($seen tables)"
check "$([ "$leaks" -eq 0 ] && echo 0 || echo 1)" "(iii) no launched session inherited fd 9 ($leaks leaks)"

# ------------------------------------------------------------------ strays ---
echo
strays=$(nr_strays)
if [ -n "$strays" ]; then printf 'stray processes still on the scratch path: %s\n' "$strays"; fi
check "$([ -z "$strays" ] && echo 0 || echo 1)" "no processes left behind under $NR_SCRATCH"

nr_summary "lock-race"
