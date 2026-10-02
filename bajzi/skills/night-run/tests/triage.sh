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
FAKE_SLEEP_TENTHS=0; FAKE_INIT_LINE=""
. "$FAKE_DIR/fake.env"
printf '%s\n' "$@" >"$FAKE_DIR/argv"
pwd -P >"$FAKE_DIR/cwd"
printf '%s\n' "$$" >"$FAKE_DIR/pid"
cat >"$FAKE_DIR/stdin"
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
cat "$FAKE_RESULT"
EOS
chmod +x "$WT/bin/update-monitor" "$WT/bin/claude"

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
  ( cd "$WT" && PATH="$WT/bin:$PATH" UM_LOG="$WT/um.log" FAKE_DIR="$FD" FAKE_RESULT="$WT/result.jsonl" \
      bash "$WATCH" --config "$ND/config.env" --once >"$ND/watch.out" 2>&1 )
  local end=$((SECONDS + 20))      # wall-clock bound: process spawns are slow on Git Bash
  while ! grep -Eq 'TICK (CONFIG OK|MISCONFIGURED)' "$ND/triage.log" 2>/dev/null && [ "$SECONDS" -lt "$end" ]; do
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

# ------------------------------------------------------------- teardown -----
LEFT=""
for p in $FAKE_PIDS; do
  END=$((SECONDS + 5)); while kill -0 "$p" 2>/dev/null && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
  if kill -0 "$p" 2>/dev/null; then LEFT="$LEFT $p"; kill "$p" 2>/dev/null; fi
done
if [ -n "$LEFT" ]; then bad "teardown: fake claude survived:$LEFT"; else ok "teardown: every fake claude has exited"; fi
rm -rf "$WT" 2>/dev/null

if [ $FAILED -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAILED
