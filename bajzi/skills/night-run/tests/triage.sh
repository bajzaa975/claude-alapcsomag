#!/usr/bin/env bash
# tests/triage.sh — the tier-1 triage tick of night-watch.sh, against a FAKE claude.
#
# The tick may commit a fix (WATCHER-BRIEF duty 4), so it must never run unsandboxed: cwd = BASE,
# the project's settings passed with --settings, and its stream-json init record must show the
# model and permission mode that were asked for — else it is killed and logged TICK MISCONFIGURED
# (fail closed). Every case builds its OWN NIGHT_DIR + BASE under one scratch tree, adds a terminal
# row to state.txt, runs `night-watch.sh --once` FROM THE SCRATCH ROOT (not from BASE, so the
# recorded cwd proves the tick's own cd) and polls triage.log for the tick's verdict line, bounded.
#
# No flock / setsid / pgrep stubs, on purpose: the cases publish no run.meta, so every tick is
# UNKNOWN (fail closed) and nothing is ever restarted — night-watch.sh never reaches setsid, and
# without flock it is UNKNOWN anyway. Runs the same under Git Bash on Windows and on Linux.
# The real update-monitor is shadowed by a stub on PATH, so nothing reaches the machine journal.
#
#   bash tests/triage.sh        # PASS/FAIL per check, non-zero on any FAIL
#   NR_SCRATCH=/some/dir bash tests/triage.sh

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WATCH=$HERE/../night-watch.sh
[ -f "$WATCH" ] || { echo "FAIL: $WATCH not found"; exit 1; }

NR_SCRATCH=${NR_SCRATCH:-${TMPDIR:-/tmp}/night-run-tests}
mkdir -p "$NR_SCRATCH" || exit 1
WT=$(mktemp -d "$NR_SCRATCH/triage.XXXXXX") || exit 1
FAILED=0
FAKE_PIDS=""

ok(){  printf 'PASS  %s\n' "$*"; }
bad(){ printf 'FAIL  %s\n' "$*"; FAILED=1; }
has(){ grep -qF -- "$2" "$1" 2>/dev/null; }                     # file text
yes(){ if has "$2" "$3"; then ok "$1"; else bad "$1 — '$3' not in $2"; fi; }
no(){  if has "$2" "$3"; then bad "$1 — '$3' found in $2"; else ok "$1"; fi; }
pair(){ # name argv-file a b: line a is directly followed by line b
  if awk -v a="$3" -v b="$4" 'p == a && $0 == b { f = 1 } { p = $0 } END { exit !f }' "$2" 2>/dev/null
  then ok "$1"; else bad "$1 — '$3 $4' not adjacent in argv: $(tr '\n' ' ' <"$2" 2>/dev/null)"; fi
}

# ---------------------------------------------------------------- fixtures ---
mkdir -p "$WT/bin"
cat >"$WT/bin/update-monitor" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${UM_LOG:-/dev/null}"
EOS
# The final result line, kept in a FILE: its JSON escapes (\n, \") must reach the tick verbatim.
cat >"$WT/result.jsonl" <<'EOS'
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"TRIAGE-RESULT line one\nsaid \"fine\"","session_id":"s1"}
EOS
# FAKE claude. Records argv (one per line), cwd (physical) and its pid, swallows the prompt on
# stdin, then prints FAKE_HOOKS hook lines, an init line (FAKE_MODEL / FAKE_PERM, none when
# FAKE_MODEL=none, verbatim FAKE_INIT_LINE when set), sleeps FAKE_SLEEP_TENTHS x 0.1 s in slices
# (a killed fake leaves no long sleep behind) and touches after-sleep, then the result line.
cat >"$WT/bin/claude" <<'EOS'
#!/usr/bin/env bash
FAKE_HOOKS=16; FAKE_MODEL=claude-sonnet-5-20261001; FAKE_PERM=bypassPermissions
FAKE_SLEEP_TENTHS=0; FAKE_INIT_LINE=""; FAKE_ERR=""; FAKE_EXIT=""; FAKE_IGNORE_TERM=""
. "$FAKE_DIR/fake.env"
[ -n "$FAKE_IGNORE_TERM" ] && trap '' TERM
printf '%s\n' "$@" >"$FAKE_DIR/argv"
pwd -P >"$FAKE_DIR/cwd"
printf '%s\n' "$$" >"$FAKE_DIR/pid"
cat >"$FAKE_DIR/stdin"
[ -n "$FAKE_ERR" ] && printf '%s\n' "$FAKE_ERR" >&2
i=0
while [ "$i" -lt "$FAKE_HOOKS" ]; do
  printf '{"type":"system","subtype":"hook_started","hook_id":"h%s","hook_name":"SessionStart:startup"}\n' "$i"
  i=$((i + 1))
done
if [ -n "$FAKE_INIT_LINE" ]; then
  printf '%s\n' "$FAKE_INIT_LINE"
elif [ "$FAKE_MODEL" != none ]; then
  printf '{"type":"system","subtype":"init","cwd":"%s","session_id":"s1","tools":["Bash"],"mcp_servers":[],"model":"%s","permissionMode":"%s","apiKeySource":"none"}\n' \
    "$PWD" "$FAKE_MODEL" "$FAKE_PERM"
fi
i=0
while [ "$i" -lt "$FAKE_SLEEP_TENTHS" ]; do sleep 0.1; i=$((i + 1)); done
[ "$FAKE_SLEEP_TENTHS" -gt 0 ] && : >"$FAKE_DIR/after-sleep"
[ -n "$FAKE_EXIT" ] && exit "$FAKE_EXIT"
cat "$FAKE_RESULT"
EOS
# date stub: while BLOCK_DIR (the tick's triage dir) exists, `date +%s` says 1000 and plants a
# DIRECTORY named like the tick's pid file (1000-<watcher pid>.pid), so that file cannot be written.
cat >"$WT/bin/date" <<'EOS'
#!/usr/bin/env bash
if [ -n "${BLOCK_DIR:-}" ] && [ -d "$BLOCK_DIR" ] && [ "$*" = "+%s" ]; then
  mkdir -p "$BLOCK_DIR/1000-$(cat "$WPID_FILE").pid"; echo 1000; exit 0
fi
exec "$REAL_DATE" "$@"
EOS
REAL_DATE=$(command -v date)
chmod +x "$WT/bin/update-monitor" "$WT/bin/claude" "$WT/bin/date"

mkcase(){ # name [fake.env lines...] -> sets ND (NIGHT_DIR), FD (fake dir), B (BASE)
  local name=$1; shift
  ND=$WT/$name; FD=$ND/fake; B=$ND/base
  mkdir -p "$ND/logs" "$FD" "$B/.claude"
  printf '{}\n' >"$B/.claude/settings.local.json"
  cat >"$ND/config.env" <<EOS
PROJECT="triagetest-$name"
NIGHT_DIR="$ND"
BASE="$B"
DISK_FLOOR_GB="1"
WATCH_INTERVAL="900"
WATCH_MAX_RESTARTS="0"
EOS
  printf 'Triage brief.\nEVENT: {{EVENT}}\nFACTS: {{FACTS}}\n' >"$ND/WATCHER-BRIEF.md"
  printf 's1 0 2026-10-02T01:00:00Z\n' >"$ND/state.txt"      # the new terminal row = the event
  : >"$FD/fake.env"
  [ $# -gt 0 ] && printf '%s\n' "$@" >"$FD/fake.env"
  return 0
}

run_case(){ # run ONE watcher tick from the scratch root, then wait for the tick's verdict line
  ( cd "$WT" && printf '%s\n' "$BASHPID" >"$ND/wpid" && PATH="$WT/bin:$PATH" UM_LOG="$WT/um.log" FAKE_DIR="$FD" \
      FAKE_RESULT="$WT/result.jsonl" REAL_DATE="$REAL_DATE" WPID_FILE="$ND/wpid" BLOCK_DIR="${BLOCK_DIR:-}" \
      exec bash "$WATCH" --config "$ND/config.env" --once >"$ND/watch.out" 2>&1 )
  local end=$((SECONDS + 20))      # wall-clock bound: process spawns are slow on Git Bash
  while ! grep -Eq 'TICK (CONFIG OK|MISCONFIGURED|FAILED)' "$ND/triage.log" 2>/dev/null && [ "$SECONDS" -lt "$end" ]; do
    sleep 0.1
  done
  [ -f "$FD/pid" ] && FAKE_PIDS="$FAKE_PIDS $(cat "$FD/pid")"
  return 0
}

not_logged(){ # case: the tick's result text never reached triage.log, nor did a CONFIG OK
  no "$1 result text NOT in triage.log" "$ND/triage.log" "TRIAGE-RESULT"
  no "$1 no TICK CONFIG OK" "$ND/triage.log" "TICK CONFIG OK"
}

# ------------------------------------------------------------ a. happy path ---
mkcase a
run_case
A=$FD/argv
if [ -f "$A" ]; then ok "a fake claude ran"; else bad "a fake claude never ran"; fi
if grep -qxF -- -p "$A" 2>/dev/null; then ok "a argv has -p"; else bad "a argv has no -p"; fi
pair "a argv --model sonnet" "$A" --model sonnet
pair "a argv --permission-mode bypassPermissions" "$A" --permission-mode bypassPermissions
pair "a argv --settings <BASE>/.claude/settings.local.json" "$A" --settings "$B/.claude/settings.local.json"
pair "a argv --output-format stream-json" "$A" --output-format stream-json
if grep -qxF -- --verbose "$A" 2>/dev/null; then ok "a argv has --verbose"; else bad "a argv has no --verbose"; fi
GOT=$(cat "$FD/cwd" 2>/dev/null); WANT=$(cd "$B" && pwd -P)
if [ "$GOT" = "$WANT" ]; then ok "a tick cwd == BASE"; else bad "a tick cwd '$GOT', wanted BASE '$WANT'"; fi
yes "a prompt on stdin carries the new state row" "$FD/stdin" "s1 0 2026-10-02T01:00:00Z"
RAW=$(ls "$ND"/triage/*.jsonl 2>/dev/null | head -1)
LN=$(grep -n '"subtype":"init"' "$RAW" 2>/dev/null | head -1 | cut -d: -f1)
if [ "$LN" = 17 ]; then ok "a raw stream saved, init found after 16 hook lines"; else bad "a raw stream '$RAW': init on line '$LN', wanted 17"; fi
yes "a result text in triage.log" "$ND/triage.log" "TRIAGE-RESULT line one"
if grep -qx 'said "fine"' "$ND/triage.log" 2>/dev/null; then ok "a result text decoded (\\n, \\\")"
else bad "a result text not decoded: $(tail -n 5 "$ND/triage.log" 2>/dev/null | tr '\n' '|')"; fi
yes "a TICK CONFIG OK in triage.log" "$ND/triage.log" "TICK CONFIG OK model=claude-sonnet-5-20261001 permissionMode=bypassPermissions"
no "a no MISCONFIGURED" "$ND/triage.log" "MISCONFIGURED"

# --------------------------------------- b. wrong model: killed mid-stream ---
mkcase b FAKE_MODEL=claude-opus-5-20261001 FAKE_SLEEP_TENTHS=150
run_case
yes "b opus init with WATCH_TRIAGE_MODEL=sonnet: MISCONFIGURED" "$ND/triage.log" "TICK MISCONFIGURED model=claude-opus-5-20261001"
yes "b MISCONFIGURED is also said on the watcher's stdout" "$ND/watch.out" "TICK MISCONFIGURED"
not_logged b
P=$(cat "$FD/pid" 2>/dev/null)
END=$((SECONDS + 5)); while [ -n "$P" ] && kill -0 "$P" 2>/dev/null && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
if [ -z "$P" ]; then bad "b fake claude recorded no pid"
elif kill -0 "$P" 2>/dev/null; then bad "b fake claude $P still alive: the tick was not killed"
elif [ -f "$FD/after-sleep" ]; then bad "b fake claude finished its post-init sleep: not killed at once"
else ok "b fake claude killed before its post-init sleep ended"; fi

# ------------------------------------------- c. wrong permission mode ---------
mkcase c FAKE_PERM=default
run_case
yes "c permissionMode=default: MISCONFIGURED" "$ND/triage.log" "TICK MISCONFIGURED model=claude-sonnet-5-20261001 permissionMode=default"
not_logged c

# ------------------------------------------------------ d. no init record -----
mkcase d FAKE_MODEL=none
run_case
yes "d no init line: MISCONFIGURED" "$ND/triage.log" "TICK MISCONFIGURED"
not_logged d

# ------------------------------------------------- e. settings file missing ---
mkcase e
rm -f "$B/.claude/settings.local.json"
run_case
yes "e settings missing: MISCONFIGURED" "$ND/triage.log" "TICK MISCONFIGURED"
yes "e MISCONFIGURED is also said on the watcher's stdout" "$ND/watch.out" "TICK MISCONFIGURED"
if [ -f "$FD/argv" ]; then bad "e fake claude ran without the settings file"; else ok "e fake claude never ran"; fi

# ------------------------------------- f. a pinned full id is its own prefix ---
mkcase f FAKE_MODEL=claude-sonnet-5-20261001
printf 'WATCH_TRIAGE_MODEL="claude-sonnet-5"\n' >>"$ND/config.env"
run_case
pair "f argv --model claude-sonnet-5" "$FD/argv" --model claude-sonnet-5
yes "f init claude-sonnet-5-20261001: TICK CONFIG OK" "$ND/triage.log" "TICK CONFIG OK model=claude-sonnet-5-20261001"
yes "f result text in triage.log" "$ND/triage.log" "TRIAGE-RESULT line one"
no "f no MISCONFIGURED" "$ND/triage.log" "MISCONFIGURED"

# ------------------------------------------------- g. BASE is not a directory ---
mkcase g
rm -rf "$B"
run_case
yes "g BASE missing: MISCONFIGURED" "$ND/triage.log" "TICK MISCONFIGURED"
if [ -f "$FD/argv" ]; then bad "g fake claude ran without BASE"; else ok "g fake claude never ran"; fi

# ------------------------------- h. an init whose model cannot be read -------
mkcase h
cat >"$FD/fake.env" <<'EOS'
FAKE_INIT_LINE='{"type":"system","subtype":"init","session_id":"s1","permissionMode":"bypassPermissions"}'
EOS
run_case
yes "h init without a model field: MISCONFIGURED" "$ND/triage.log" "TICK MISCONFIGURED"
not_logged h

# ---------------------- i. pid file cannot be written: claude must not start ---
mkcase i FAKE_MODEL=claude-opus-5-20261001 FAKE_SLEEP_TENTHS=150
BLOCK_DIR=$ND/triage run_case
if [ -f "$FD/argv" ]; then bad "i fake claude ran although its pid file could not be written"; else ok "i fake claude never ran"; fi
yes "i MISCONFIGURED logged" "$ND/triage.log" "TICK MISCONFIGURED"
no "i never says 'tick killed'" "$ND/triage.log" "tick killed"
yes "i the .err file says why" "$(ls "$ND"/triage/*.err 2>/dev/null | head -1)" "cannot write"

# ------------------------- j. a tick that ignores TERM: dead before 'tick killed' ---
mkcase j FAKE_MODEL=claude-opus-5-20261001 FAKE_SLEEP_TENTHS=300 FAKE_IGNORE_TERM=1
run_case
yes "j MISCONFIGURED logged" "$ND/triage.log" "TICK MISCONFIGURED model=claude-opus-5-20261001"
P=$(cat "$FD/pid" 2>/dev/null)
if grep -qF "tick killed" "$ND/triage.log" 2>/dev/null; then
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then bad "j triage.log says 'tick killed' while the fake $P is alive"; else ok "j 'tick killed' only once the fake is dead"; fi
elif grep -qF "NOT confirmed killed" "$ND/triage.log" 2>/dev/null; then bad "j tick ignoring TERM was never killed"
else bad "j no kill verdict in triage.log"; fi

# --------- k. unsupported WATCH_TRIAGE_MODEL values are refused before launch ---
for m in opusplan 'sonnet[1m]'; do
  mkcase k
  printf 'WATCH_TRIAGE_MODEL="%s"\n' "$m" >>"$ND/config.env"
  run_case
  yes "k $m: refused with the documented message" "$ND/triage.log" "TICK MISCONFIGURED unsupported WATCH_TRIAGE_MODEL=$m (use sonnet|opus|haiku or a full claude-* id)"
  if [ -f "$FD/argv" ]; then bad "k $m: claude was launched"; else ok "k $m: claude never started"; fi
done

# ----------------- m. stderr and exit before any init record: .err is named ---
mkcase m FAKE_MODEL=none FAKE_ERR=FAKE-BOOM FAKE_EXIT=1
run_case
yes "m MISCONFIGURED no init record" "$ND/triage.log" "TICK MISCONFIGURED no init record"
yes "m triage.log names the .err file" "$ND/triage.log" ".err"
yes "m triage.log shows the stderr text" "$ND/triage.log" "FAKE-BOOM"

# ------------- n. good init, then a non-zero exit and no result line ---------
mkcase n FAKE_ERR=FAKE-CRASH FAKE_EXIT=3
run_case
END=$((SECONDS + 10)); while ! grep -q "TICK FAILED exit 3" "$ND/triage.log" 2>/dev/null && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
yes "n TICK FAILED no result line" "$ND/triage.log" "TICK FAILED no result line"
yes "n TICK FAILED names the exit code" "$ND/triage.log" "TICK FAILED exit 3"
yes "n triage.log names the .err file" "$ND/triage.log" ".err"
no "n no plain TICK CONFIG OK" "$ND/triage.log" "TICK CONFIG OK"

# ------------------------------------------------------------- teardown -----
# Only a pid whose command line still names THIS scratch tree is ever signalled (pids get reused).
mine(){ # pid: its command line mentions the scratch dir
  { tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || ps -p "$1" -o args= 2>/dev/null; } | grep -qF -- "${WT##*/}"
}
LEFT=""
for p in $FAKE_PIDS; do
  END=$((SECONDS + 5)); while kill -0 "$p" 2>/dev/null && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
  if kill -0 "$p" 2>/dev/null && mine "$p"; then LEFT="$LEFT $p"; kill "$p" 2>/dev/null; fi
done
if [ -n "$LEFT" ]; then bad "teardown: fake claude survived:$LEFT"; else ok "teardown: every fake claude has exited"; fi
# Sweep: nothing may still mention the scratch path (needs /proc; skipped where there is none).
STRAY=""
for d in /proc/[0-9]*; do
  q=${d#/proc/}; [ "$q" = "$$" ] && continue
  mine "$q" && { STRAY="$STRAY $q"; kill -KILL "$q" 2>/dev/null; }
done
if [ -n "$STRAY" ]; then bad "teardown: stray processes mentioning the scratch path:$STRAY"; else ok "teardown: no process mentions the scratch path"; fi
rm -rf "$WT" 2>/dev/null

if [ $FAILED -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAILED
