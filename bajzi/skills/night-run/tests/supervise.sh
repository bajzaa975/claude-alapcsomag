#!/usr/bin/env bash
# tests/supervise.sh — the 30-minute mid-story supervisor (supervise.sh), against a FAKE claude.
#
# supervise.sh sleeps FIRST, then per iteration re-reads run.meta's started_epoch, exits on
# SUPERVISE-STOP / STOP / a `finished` >= started_epoch, else runs ONE fresh headless tick launched
# fail-closed through tick-lib.sh (provider env scrubbed, stream-json init record checked). Every
# case builds its OWN NIGHT_DIR under one scratch tree, with short intervals, a fake `claude` first
# on PATH and BAJZI_HOME pointing at a scratch reviewer allow-list (the real one is never read).
# The parent env carries GLM provider variables on purpose: the fake records its env, and none of
# them may reach it. The zero-token gate before each tick runs against a fake `gh` and `flock` stubs;
# the cases that predate it set SUPERVISE_FORCE_EVERY_MIN=0 (gate off: every tick launches).
#
# No flock / setsid / pgrep needed: runs the same under Git Bash on Windows and on Linux. The only
# processes ever signalled are pids this script started itself (recorded from $!).
#
#   bash tests/supervise.sh        # PASS/FAIL per check, non-zero on any FAIL
#   NR_SCRATCH=/some/dir bash tests/supervise.sh

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SKILL=$HERE/..
SUP=$SKILL/supervise.sh
[ -f "$SUP" ] || { echo "FAIL: $SUP not found"; echo "SOME FAILED"; exit 1; }

NR_SCRATCH=${NR_SCRATCH:-${TMPDIR:-/tmp}/night-run-tests}
mkdir -p "$NR_SCRATCH" || exit 1
WT=$(mktemp -d "$NR_SCRATCH/supervise.XXXXXX") || exit 1
FAILED=0
MY_PIDS=""

ok(){  printf 'PASS  %s\n' "$*"; }
bad(){ printf 'FAIL  %s\n' "$*"; FAILED=1; }
has(){ grep -qF -- "$2" "$1" 2>/dev/null; }
yes(){ if has "$2" "$3"; then ok "$1"; else bad "$1 — '$3' not in $2: $(tail -n 4 "$2" 2>/dev/null | tr '\n' '|')"; fi; }
no(){  if has "$2" "$3"; then bad "$1 — '$3' found in $2"; else ok "$1"; fi; }
pair(){ # name argv-file a b: line a is directly followed by line b
  if awk -v a="$3" -v b="$4" 'p == a && $0 == b { f = 1 } { p = $0 } END { exit !f }' "$2" 2>/dev/null
  then ok "$1"; else bad "$1 — '$3 $4' not adjacent in argv: $(tr '\n' ' ' <"$2" 2>/dev/null)"; fi
}
wait_for(){ # file fixed-string seconds -> 0 once the string is in the file
  local end=$((SECONDS + $3))
  while ! has "$1" "$2"; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 0.1; done
  return 0
}
wait_gone(){ # pid seconds -> 0 once the pid is gone
  local end=$((SECONDS + $2))
  while kill -0 "$1" 2>/dev/null; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 0.1; done
  return 0
}

# ---------------------------------------------------------------- fixtures ---
mkdir -p "$WT/bin" "$WT/nodestub"
cat >"$WT/result.jsonl" <<'EOS'
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"SUPERVISE-RESULT OK S1 progressing","session_id":"s1"}
EOS
# FAKE claude: records argv, cwd, pid, env and stdin; prints hook lines, an init record
# (FAKE_MODEL / FAKE_PERM), sleeps FAKE_SLEEP_TENTHS x 0.1 s and touches after-sleep, then the result.
cat >"$WT/bin/claude" <<'EOS'
#!/usr/bin/env bash
FAKE_HOOKS=3; FAKE_MODEL=claude-opus-5-5-20261001; FAKE_PERM=bypassPermissions; FAKE_SLEEP_TENTHS=0
. "$FAKE_DIR/fake.env"
printf '%s\n' "$@" >"$FAKE_DIR/argv"
pwd -P >"$FAKE_DIR/cwd"
printf '%s\n' "$$" >"$FAKE_DIR/pid"
env >"$FAKE_DIR/env"
cat >"$FAKE_DIR/stdin"
i=0
while [ "$i" -lt "$FAKE_HOOKS" ]; do
  printf '{"type":"system","subtype":"hook_started","hook_id":"h%s"}\n' "$i"; i=$((i + 1))
done
printf '{"type":"system","subtype":"init","cwd":"%s","session_id":"s1","model":"%s","permissionMode":"%s"}\n' \
  "$PWD" "$FAKE_MODEL" "$FAKE_PERM"
i=0
while [ "$i" -lt "$FAKE_SLEEP_TENTHS" ]; do sleep 0.1; i=$((i + 1)); done
[ "$FAKE_SLEEP_TENTHS" -gt 0 ] && : >"$FAKE_DIR/after-sleep"
cat "$FAKE_RESULT"
EOS
# A `node` that answers the allow-list read with a value that is no Claude alias and no claude-* id.
cat >"$WT/nodestub/node" <<'EOS'
#!/usr/bin/env bash
echo 'opusplan'
EOS
# A FAKE gh (the real one is on PATH on the laptop: no case may reach the network): records its argv,
# prints $FAKE_DIR/gh.json (default []) and exits with $FAKE_DIR/gh.rc (default 0).
cat >"$WT/bin/gh" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_DIR/gh.argv"
if [ -f "$FAKE_DIR/gh.json" ]; then cat "$FAKE_DIR/gh.json"; else echo '[]'; fi
exit "$(cat "$FAKE_DIR/gh.rc" 2>/dev/null || echo 0)"
EOS
# flock stubs: held = a runner holds run.flock (flock -n -E 75 exits 75), err = a probe error.
mkdir -p "$WT/flockheld" "$WT/flockerr"
printf '#!/usr/bin/env bash\nexit 75\n' >"$WT/flockheld/flock"
printf '#!/usr/bin/env bash\nexit 66\n' >"$WT/flockerr/flock"
chmod +x "$WT/bin/claude" "$WT/nodestub/node" "$WT/bin/gh" "$WT/flockheld/flock" "$WT/flockerr/flock"

# The NIGHT_DIR form a native node sees: Git Bash rewrites a POSIX argument to C:/...; Linux keeps it.
nat(){ if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

allow(){ # dir id... -> writes <dir>/.claude/bajzi/config.json with reviewer_models = the ids
  local d=$1; shift
  mkdir -p "$d/.claude/bajzi"
  local j="" x
  for x in "$@"; do j="$j${j:+,}\"$x\""; done
  printf '{"reviewer_models":[%s]}\n' "$j" >"$d/.claude/bajzi/config.json"
}

mkcase(){ # name interval timeout [fake.env lines...] -> ND, FD, BH
  local name=$1 iv=$2 to=$3; shift 3
  ND=$WT/$name; FD=$ND/fake; BH=$ND/home
  mkdir -p "$ND/logs" "$FD" "$ND/base/.claude"
  # BASE's installed night settings: this night's state deny (in the form node sees NIGHT_DIR) and a
  # sentinel; supervise.settings.json starts STALE ({}): each tick must rewrite it from BASE's file.
  printf '{"permissions":{"deny":["Edit(%s/state*.txt)","Read(sentinel-%s)"]}}\n' "$(nat "$ND")" "$name" \
    >"$ND/base/.claude/settings.local.json"
  printf '{}\n' >"$ND/supervise.settings.json"
  cat >"$ND/config.env" <<EOS
PROJECT="suptest-$name"
NIGHT_DIR="$ND"
BASE="$ND/base"
SUPERVISE_INTERVAL="$iv"
SUPERVISE_TICK_TIMEOUT="$to"
SUPERVISE_FORCE_EVERY_MIN="0"
EOS
  printf 'pgid=1\nstarted_epoch=%s\nmode=queue\n' "$(($(date +%s) - 100))" >"$ND/run.meta"
  printf 'Supervise prompt for the test.\n' >"$ND/SUPERVISE-PROMPT.md"
  allow "$BH" claude-opus-5-5 claude-sonnet-5
  : >"$FD/fake.env"
  [ $# -gt 0 ] && printf '%s\n' "$@" >"$FD/fake.env"
  return 0
}

start_sup(){ # [extra PATH dir] -> SPID; runs supervise.sh in the background from the scratch root
  local pre=${1:-}
  ( cd "$WT" && PATH="$pre${pre:+:}$WT/bin:$PATH" FAKE_DIR="$FD" FAKE_RESULT="$WT/result.jsonl" BAJZI_HOME="$BH" \
      ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" ANTHROPIC_AUTH_TOKEN="glm-fake-token" \
      ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5" CC_WORKER_MODE="glm" CLAUDECODE=1 \
      exec bash "$SUP" --config "$ND/config.env" >>"$ND/sup.out" 2>&1 ) &
  SPID=$!
  MY_PIDS="$MY_PIDS $SPID"
}

finish_case(){ # stop the case's supervisor through SUPERVISE-STOP and check it is gone
  : >"$ND/SUPERVISE-STOP"
  if wait_for "$ND/supervisor.log" "supervisor stopped (SUPERVISE-STOP)" 30 && wait_gone "$SPID" 10; then
    ok "$1 'supervisor stopped (SUPERVISE-STOP)' logged and the process exited"
  else
    bad "$1 supervisor did not stop on SUPERVISE-STOP: $(tail -n 3 "$ND/supervisor.log" 2>/dev/null | tr '\n' '|')"
  fi
}

# ------------------------------------- a. happy path: sleep first, one good tick ---
mkcase a 4 3
allow "$BH" claude-haiku-4                 # replaced below, BEFORE the first tick: read at tick time
start_sup
sleep 1.5
allow "$BH" claude-opus-5-5 claude-sonnet-5
if [ -f "$FD/argv" ] || has "$ND/logs/supervisor-ticks.log" "tick exit="; then
  bad "a a tick ran before the first SUPERVISE_INTERVAL elapsed"
else ok "a sleeps first: no tick in the first 1.5 s of a 4 s interval"; fi
if wait_for "$ND/logs/supervisor-ticks.log" "tick exit=0" 30; then ok "a '<ISO> tick exit=0' in logs/supervisor-ticks.log"
else bad "a no 'tick exit=0' in logs/supervisor-ticks.log: $(cat "$ND/supervisor.log" 2>/dev/null | tr '\n' '|')"; fi
A=$FD/argv
if grep -qxF -- -p "$A" 2>/dev/null; then ok "a argv has -p"; else bad "a argv has no -p"; fi
pair "a argv --model claude-opus-5-5 (allow-list [0], read at tick time)" "$A" --model claude-opus-5-5
pair "a argv --permission-mode bypassPermissions" "$A" --permission-mode bypassPermissions
pair "a argv --settings <NIGHT_DIR>/supervise.settings.json (the night deny list minus the state-file deny)" "$A" --settings "$ND/supervise.settings.json"
pair "a argv --setting-sources user,project (BASE's settings.local.json, which keeps the state deny, not loaded)" "$A" --setting-sources user,project
pair "a argv --output-format stream-json" "$A" --output-format stream-json
if grep -qxF -- --verbose "$A" 2>/dev/null; then ok "a argv has --verbose"; else bad "a argv has no --verbose"; fi
GOT=$(cat "$FD/cwd" 2>/dev/null); WANT=$(cd "$ND/base" && pwd -P)
if [ "$GOT" = "$WANT" ]; then ok "a tick cwd == BASE (repo-relative denies anchored at the checkout)"; else bad "a tick cwd '$GOT', wanted BASE '$WANT'"; fi
yes "a the rendered prompt reached the tick on stdin" "$FD/stdin" "Supervise prompt for the test."
for v in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_DEFAULT_OPUS_MODEL CC_WORKER_MODE CLAUDECODE; do
  if grep -q "^$v=" "$FD/env" 2>/dev/null; then bad "a provider env $v reached the tick"
  elif [ -s "$FD/env" ]; then ok "a provider env $v scrubbed"; else bad "a fake recorded no env"; fi
done
yes "a supervise.settings.json rewritten at tick time from BASE's installed file (stale {} replaced)" "$ND/supervise.settings.json" "Read(sentinel-a)"
no "a supervise.settings.json lacks this night's state deny" "$ND/supervise.settings.json" "state*.txt"
yes "a decoded result in logs/supervisor-ticks.log" "$ND/logs/supervisor-ticks.log" "SUPERVISE-RESULT OK S1 progressing"
yes "a 'SUPERVISE CONFIG OK' in supervisor.log" "$ND/supervisor.log" "SUPERVISE CONFIG OK model=claude-opus-5-5-20261001 permissionMode=bypassPermissions"
no "a no MISCONFIGURED" "$ND/supervisor.log" "MISCONFIGURED"
RAW=$(ls "$ND"/supervise/*.jsonl 2>/dev/null | head -1)
if [ -n "$RAW" ] && grep -q '"subtype":"init"' "$RAW"; then ok "a raw stream saved under supervise/"; else bad "a no raw stream under $ND/supervise/"; fi
# The allow-list is re-read on EVERY tick, not cached from the first one.
allow "$BH" claude-sonnet-5 claude-opus-5-5
printf 'FAKE_MODEL=claude-sonnet-5-20261001\n' >"$FD/fake.env"
END=$((SECONDS + 30))
while [ "$(grep -c 'tick exit=' "$ND/logs/supervisor-ticks.log" 2>/dev/null)" -lt 2 ] && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
pair "a tick 2 argv --model claude-sonnet-5 (allow-list changed between ticks)" "$A" --model claude-sonnet-5
yes "a tick 2 'SUPERVISE CONFIG OK model=claude-sonnet-5-20261001'" "$ND/supervisor.log" "SUPERVISE CONFIG OK model=claude-sonnet-5-20261001 permissionMode=bypassPermissions"
finish_case a
if [ -e "$ND/supervise.pid" ]; then bad "a supervise.pid left behind"; else ok "a supervise.pid removed on exit"; fi

# ------------------------------------------------------- b. the run's STOP ---
mkcase b 2 1
printf 'owner stop\n' >"$ND/STOP"
start_sup
if wait_for "$ND/supervisor.log" "supervisor stopped (STOP present)" 20 && wait_gone "$SPID" 10; then
  ok "b 'supervisor stopped (STOP present)' logged and the process exited"
else bad "b no exit on STOP: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "b a tick ran although STOP exists"; else ok "b no tick ran"; fi

# ------------------------------------------- c. finished >= started_epoch ---
mkcase c 2 1
date +%s >"$ND/finished"
start_sup
if wait_for "$ND/supervisor.log" "supervisor exits: runner finished" 20 && wait_gone "$SPID" 10; then
  ok "c 'supervisor exits: runner finished' logged and the process exited"
else bad "c no exit on finished: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "c a tick ran although the run finished"; else ok "c no tick ran"; fi

# ------------- d. started_epoch is RE-READ: a relaunch makes an old finished stale ---
mkcase d 4 3
S1=$(($(date +%s) - 1000))
printf 'pgid=1\nstarted_epoch=%s\nmode=queue\n' "$S1" >"$ND/run.meta"
start_sup
# Iteration 1 reads started_epoch=S1 and ticks; only THEN the relaunch republishes run.meta, so a
# supervisor that kept the first value would now exit on a finished that lies between the starts.
wait_for "$ND/logs/supervisor-ticks.log" "tick exit=0" 30 || bad "d first tick never ran"
printf '%s\n' "$((S1 + 500))" >"$ND/finished"
printf 'pgid=2\nstarted_epoch=%s\nmode=queue\n' "$(date +%s)" >"$ND/run.meta"
END=$((SECONDS + 30))
while [ "$(grep -c 'tick exit=0' "$ND/logs/supervisor-ticks.log" 2>/dev/null)" -lt 2 ] && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
if [ "$(grep -c 'tick exit=0' "$ND/logs/supervisor-ticks.log" 2>/dev/null)" -ge 2 ]; then ok "d finished older than the re-read started_epoch: a second tick ran"
else bad "d no tick after the relaunch: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
no "d did not exit on the stale finished" "$ND/supervisor.log" "supervisor exits: runner finished"
date +%s >"$ND/finished"                    # now the relaunched run finishes
if wait_for "$ND/supervisor.log" "supervisor exits: runner finished" 30 && wait_gone "$SPID" 10; then
  ok "d then 'supervisor exits: runner finished' once finished >= the new started_epoch"
else bad "d no exit on the new finished: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi

# ------------------------------------- e. single instance, stale pid takeover ---
mkcase e 30 10
start_sup
A_PID=$SPID
END=$((SECONDS + 15))
while [ "$(cat "$ND/supervise.pid" 2>/dev/null)" != "$A_PID" ] && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
if [ "$(cat "$ND/supervise.pid" 2>/dev/null)" = "$A_PID" ]; then ok "e first instance wrote supervise.pid"; else bad "e supervise.pid is not $A_PID"; fi
( cd "$WT" && PATH="$WT/bin:$PATH" BAJZI_HOME="$BH" FAKE_DIR="$FD" timeout 20 bash "$SUP" --config "$ND/config.env" >"$ND/second.out" 2>&1 )
RC=$?
if [ "$RC" -eq 0 ]; then ok "e second instance exited 0 at once"; else bad "e second instance exit $RC"; fi
yes "e second instance says 'another supervise.sh is already watching'" "$ND/second.out" "another supervise.sh is already watching $ND (pid $A_PID) — exiting."
if kill -0 "$A_PID" 2>/dev/null; then ok "e first instance still alive"; else bad "e first instance died"; fi
kill "$A_PID" 2>/dev/null
if wait_gone "$A_PID" 10; then ok "e TERM stops the sleeping supervisor"; else bad "e supervisor $A_PID ignored TERM"; fi
if [ -e "$ND/supervise.pid" ]; then bad "e supervise.pid left after TERM"; else ok "e supervise.pid removed after TERM"; fi
sleep 0 & DEAD=$!; wait "$DEAD"
printf '%s\n' "$DEAD" >"$ND/supervise.pid"
start_sup
if wait_for "$ND/sup.out" "holds pid $DEAD, which is not a live supervise.sh for this run — taking it over." 15; then
  ok "e stale supervise.pid: 'holds pid $DEAD, which is not a live supervise.sh for this run — taking it over.'"
else bad "e stale pid not taken over: $(tr '\n' '|' <"$ND/sup.out" 2>/dev/null)"; fi
END=$((SECONDS + 10))
while [ "$(cat "$ND/supervise.pid" 2>/dev/null)" != "$SPID" ] && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
if [ "$(cat "$ND/supervise.pid" 2>/dev/null)" = "$SPID" ]; then ok "e takeover wrote its own pid"; else bad "e supervise.pid is not $SPID"; fi
kill "$SPID" 2>/dev/null; wait_gone "$SPID" 10 || bad "e takeover instance ignored TERM"

# ---------------------------- f. wrong model in the init record: killed, no result ---
mkcase f 6 5 FAKE_MODEL=claude-sonnet-5-20261001 FAKE_SLEEP_TENTHS=40
start_sup
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED model=claude-sonnet-5-20261001 permissionMode=bypassPermissions, wanted model=claude-opus-5-5* permissionMode=bypassPermissions" 30; then
  ok "f 'SUPERVISE MISCONFIGURED model=claude-sonnet-5-20261001 ...' in supervisor.log"
else bad "f no MISCONFIGURED: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
wait_for "$ND/logs/supervisor-ticks.log" "tick exit=" 15 || :
no "f result text NOT in logs/supervisor-ticks.log" "$ND/logs/supervisor-ticks.log" "SUPERVISE-RESULT"
no "f no SUPERVISE CONFIG OK" "$ND/supervisor.log" "SUPERVISE CONFIG OK"
P=$(cat "$FD/pid" 2>/dev/null)
if [ -z "$P" ]; then bad "f fake recorded no pid"
elif ! wait_gone "$P" 5; then bad "f fake claude $P still alive"
elif [ -f "$FD/after-sleep" ]; then bad "f fake finished its post-init sleep: not killed at once"
else ok "f fake claude killed before its post-init sleep ended"; fi
finish_case f

# -------------------------------------------- g. non-bypass permission mode ---
mkcase g 4 3 FAKE_PERM=default
start_sup
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED model=claude-opus-5-5-20261001 permissionMode=default" 30; then
  ok "g 'SUPERVISE MISCONFIGURED ... permissionMode=default' in supervisor.log"
else bad "g no MISCONFIGURED: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
wait_for "$ND/logs/supervisor-ticks.log" "tick exit=" 15 || :
no "g result text NOT in logs/supervisor-ticks.log" "$ND/logs/supervisor-ticks.log" "SUPERVISE-RESULT"
finish_case g

# ------------------------- h. allow-list unusable: refused, claude never starts ---
mkcase h 2 1
printf '{"reviewer_models":["glm-5"]}\n' >"$BH/.claude/bajzi/config.json"
start_sup
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED reviewer allow-list unreadable" 20; then
  ok "h invalid allow-list: 'SUPERVISE MISCONFIGURED reviewer allow-list unreadable'"
else bad "h no refusal: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "h claude ran on an invalid allow-list"; else ok "h claude never started"; fi
finish_case h

mkcase h2 2 1
start_sup "$WT/nodestub"
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED unsupported reviewer_models[0]=opusplan (use sonnet|opus|haiku or a full claude-* id)" 20; then
  ok "h2 non-Claude model refused: 'SUPERVISE MISCONFIGURED unsupported reviewer_models[0]=opusplan ...'"
else bad "h2 no refusal: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "h2 claude ran with model opusplan"; else ok "h2 claude never started"; fi
finish_case h2

# ---------------------------------- i. prompt missing or unrendered: refused ---
mkcase i 2 1
rm -f "$ND/SUPERVISE-PROMPT.md"
start_sup
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED $ND/SUPERVISE-PROMPT.md is missing or unrendered" 20; then
  ok "i missing prompt: 'SUPERVISE MISCONFIGURED <ND>/SUPERVISE-PROMPT.md is missing or unrendered'"
else bad "i no refusal: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
printf 'Project {{PROJECT}}\n' >"$ND/SUPERVISE-PROMPT.md"; : >"$ND/supervisor.log"
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED $ND/SUPERVISE-PROMPT.md is missing or unrendered" 20; then
  ok "i prompt with '{{': refused the same way"
else bad "i unrendered prompt not refused"; fi
if [ -f "$FD/argv" ]; then bad "i claude ran without a rendered prompt"; else ok "i claude never started"; fi
finish_case i

# ------------------------------------------------- j. config validation ---
mkcase j 5 5
( cd "$WT" && bash "$SUP" --config "$ND/config.env" >"$ND/j.out" 2>&1 ); RC=$?
if [ "$RC" -eq 2 ]; then ok "j tick timeout == interval: exit 2"; else bad "j exit $RC, wanted 2"; fi
yes "j says why" "$ND/j.out" "supervise.sh: SUPERVISE_TICK_TIMEOUT (5) must be less than SUPERVISE_INTERVAL (5)"
mkcase j2 x 5
( cd "$WT" && bash "$SUP" --config "$ND/config.env" >"$ND/j.out" 2>&1 ); RC=$?
if [ "$RC" -eq 2 ]; then ok "j2 non-integer interval: exit 2"; else bad "j2 exit $RC, wanted 2"; fi
yes "j2 says why" "$ND/j.out" "supervise.sh: SUPERVISE_INTERVAL must be a whole number of seconds > 0, got 'x'"
# The gate keys: whole minutes, STALL and DEADLINE >= 1, FORCE_EVERY >= 0 (0 = gate off).
jcase(){ # name config-line wanted-message -> supervise.sh (loop and --check) exits 2 saying why
  mkcase "$1" 2 1; printf '%s\n' "$2" >>"$ND/config.env"
  local m
  for m in loop --check; do
    if [ "$m" = loop ]; then ( cd "$WT" && PATH="$WT/bin:$PATH" FAKE_DIR="$FD" FAKE_RESULT="$WT/result.jsonl" BAJZI_HOME="$BH" timeout 10 bash "$SUP" --config "$ND/config.env" >"$ND/j.out" 2>&1 ); RC=$?
    else ( cd "$WT" && PATH="$WT/bin:$PATH" FAKE_DIR="$FD" BAJZI_HOME="$BH" timeout 10 bash "$SUP" --check --config "$ND/config.env" >"$ND/j.out" 2>&1 ); RC=$?; fi
    if [ "$RC" -eq 2 ] && has "$ND/j.out" "$3"; then ok "$1 ($m) $2: exit 2, '$3'"
    else bad "$1 ($m) $2: rc $RC, $(head -3 "$ND/j.out" | tr '\n' '|')"; fi
  done
  if [ -e "$ND/supervisor.log" ] || [ -e "$ND/supervise.pid" ]; then bad "$1 a refused config wrote supervisor.log or supervise.pid"; fi
}
jcase j3 'SUPERVISE_STALL_MIN="0"' "supervise.sh: SUPERVISE_STALL_MIN must be a whole number of minutes >= 1, got '0'"
jcase j4 'SUPERVISE_STALL_MIN="45m"' "supervise.sh: SUPERVISE_STALL_MIN must be a whole number of minutes >= 1, got '45m'"
jcase j5 'SUPERVISE_DEADLINE_MIN="0"' "supervise.sh: SUPERVISE_DEADLINE_MIN must be a whole number of minutes >= 1, got '0'"
jcase j6 'SUPERVISE_FORCE_EVERY_MIN="two"' "supervise.sh: SUPERVISE_FORCE_EVERY_MIN must be a whole number of minutes >= 0, got 'two'"

# run.sh validates the same keys before it touches anything (--dry-run: no lock, no launch).
RN=$WT/runsh; mkdir -p "$RN"
runcfg(){ # extra config lines -> runs run.sh --dry-run, output in $RN/out, rc in RC
  cat >"$RN/config.env" <<EOS
NIGHT_DIR="$RN"
BASE="$RN"
REPO="o/r"
BASE_BRANCH="dev"
MODEL="claude-opus-5-5"
PER_STORY_TIMEOUT="3600"
PROJECT="suptest"
BRANCH_PREFIX="t"
DISK_FLOOR_GB="1"
REQUIRED_CHECK="CI"
GIT_USER_NAME="t"
GIT_USER_EMAIL="t@example.invalid"
EOS
  printf '%s\n' "$@" >>"$RN/config.env"
  ( cd "$WT" && bash "$SKILL/run.sh" --config "$RN/config.env" --dry-run >"$RN/out" 2>&1 ); RC=$?
}
runcfg 'SUPERVISE="2"'
if [ "$RC" -eq 2 ] && has "$RN/out" "run.sh: SUPERVISE must be 0 or 1, got '2'"; then ok "k run.sh refuses SUPERVISE=2: 'run.sh: SUPERVISE must be 0 or 1, got '2''"
else bad "k run.sh SUPERVISE=2: rc $RC, $(head -3 "$RN/out" | tr '\n' '|')"; fi
runcfg 'SUPERVISE_INTERVAL="soon"'
if [ "$RC" -eq 2 ] && has "$RN/out" "run.sh: SUPERVISE_INTERVAL must be a whole number, got 'soon'"; then ok "k run.sh refuses a non-integer SUPERVISE_INTERVAL"
else bad "k run.sh SUPERVISE_INTERVAL=soon: rc $RC, $(head -3 "$RN/out" | tr '\n' '|')"; fi
runcfg 'SUPERVISE_INTERVAL="600"' 'SUPERVISE_TICK_TIMEOUT="600"'
if [ "$RC" -eq 2 ] && has "$RN/out" "run.sh: SUPERVISE_TICK_TIMEOUT (600) must be less than SUPERVISE_INTERVAL (600)"; then ok "k run.sh refuses tick timeout >= interval"
else bad "k run.sh timeout>=interval: rc $RC, $(head -3 "$RN/out" | tr '\n' '|')"; fi
runcfg 'SUPERVISE_TICK_TIMEOUT="0"'
if [ "$RC" -eq 2 ] && has "$RN/out" "run.sh: SUPERVISE_TICK_TIMEOUT must be at least 1 second, got '0'"; then ok "k run.sh refuses SUPERVISE_TICK_TIMEOUT=0"
else bad "k run.sh SUPERVISE_TICK_TIMEOUT=0: rc $RC, $(head -3 "$RN/out" | tr '
' '|')"; fi
runcfg 'SUPERVISE_TICK_TIMEOUT="1799"'
no "k run.sh accepts the defaults with a 1799 s tick" "$RN/out" "SUPERVISE"
# The gate keys, validated with supervise.sh's rules: a typo stops the launch, not the supervisor.
kgate(){ # config-line wanted-message
  runcfg "$1"
  if [ "$RC" -eq 2 ] && has "$RN/out" "$2"; then ok "k run.sh refuses $1: '$2'"
  else bad "k run.sh $1: rc $RC, $(head -3 "$RN/out" | tr '\n' '|')"; fi
}
kgate 'SUPERVISE_STALL_MIN="soon"' "run.sh: SUPERVISE_STALL_MIN must be a whole number, got 'soon'"
kgate 'SUPERVISE_STALL_MIN="0"' "run.sh: SUPERVISE_STALL_MIN must be at least 1 minute, got '0'"
kgate 'SUPERVISE_FORCE_EVERY_MIN="2h"' "run.sh: SUPERVISE_FORCE_EVERY_MIN must be a whole number, got '2h'"
kgate 'SUPERVISE_DEADLINE_MIN="x"' "run.sh: SUPERVISE_DEADLINE_MIN must be a whole number, got 'x'"
kgate 'SUPERVISE_DEADLINE_MIN="0"' "run.sh: SUPERVISE_DEADLINE_MIN must be at least 1 minute, got '0'"
runcfg 'SUPERVISE_FORCE_EVERY_MIN="0"' 'SUPERVISE_STALL_MIN="1"' 'SUPERVISE_DEADLINE_MIN="1"'
no "k run.sh accepts SUPERVISE_FORCE_EVERY_MIN=0 (gate off) and STALL/DEADLINE 1" "$RN/out" "SUPERVISE"

# ------------------------- l. run.sh spawn_supervisor, executed with stubs ---
FN=$(sed -n '/^spawn_supervisor(){/,/^}/p' "$SKILL/run.sh")
if [ -n "$FN" ]; then ok "l run.sh defines spawn_supervisor"; else bad "l run.sh has no spawn_supervisor(){ ... }"; fi
SD=$WT/spawn; mkdir -p "$SD/skill" "$SD/night"
cat >"$SD/skill/supervise.sh" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$SPAWN_DIR/argv"
if { : >&9; } 2>/dev/null; then echo open >"$SPAWN_DIR/fd9"; else echo closed >"$SPAWN_DIR/fd9"; fi
cat >"$SPAWN_DIR/stdin"
EOS
cat >"$SD/setsid" <<'EOS'
#!/usr/bin/env bash
exec "$@"
EOS
chmod +x "$SD/setsid"
spawn_case(){ # SUPERVISE value -> runs the extracted function with fd 9 open and stdin carrying LEAK
  rm -f "$SD/argv" "$SD/fd9" "$SD/stdin" "$SD/log"
  ( SKILL_DIR=$SD/skill NIGHT_DIR=$SD/night LOGS=$SD/night CONFIG=$SD/cfg.env SETSID=$SD/setsid SUPERVISE=$1 SUPERVISE_INTERVAL=1800 SUPERVISE_TICK_TIMEOUT=1500 SPAWN_DIR=$SD
    export SPAWN_DIR
    log(){ printf '%s\n' "$*" >>"$SD/log"; }
    eval "$FN"
    exec 9>"$SD/lockfile"
    spawn_supervisor <<<"LEAK"
    wait )
}
spawn_case 0
yes "l SUPERVISE=0: 'supervisor disabled (SUPERVISE=0)'" "$SD/log" "supervisor disabled (SUPERVISE=0)"
if [ -f "$SD/argv" ]; then bad "l SUPERVISE=0 spawned supervise.sh"; else ok "l SUPERVISE=0 spawns nothing"; fi
spawn_case 1
END=$((SECONDS + 10)); while [ ! -f "$SD/stdin" ] && [ "$SECONDS" -lt "$END" ]; do sleep 0.1; done
pair "l SUPERVISE=1 spawns supervise.sh --config <config>" "$SD/argv" --config "$SD/cfg.env"
yes "l spawned without fd 9 (the run lock)" "$SD/fd9" "closed"
if [ -f "$SD/stdin" ] && ! has "$SD/stdin" LEAK; then ok "l spawned with stdin /dev/null"; else bad "l stdin was not /dev/null"; fi
yes "l 'supervisor started' logged" "$SD/log" "supervisor started (pid"

# ------- n. BASE's installed settings lack this night's state deny: refused, claude never starts ---
mkcase n 2 1
printf '{"permissions":{"deny":["Read(sentinel-n)"]}}\n' >"$ND/base/.claude/settings.local.json"
start_sup
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED supset: 0 rules in $(nat "$ND")/base/.claude/settings.local.json" 20 \
   && wait_for "$ND/supervisor.log" "— claude not launched" 5; then
  ok "n 'SUPERVISE MISCONFIGURED supset: 0 rules in <BASE>/.claude/settings.local.json ... — claude not launched'"
else bad "n no refusal: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "n claude ran without a valid supervisor settings file"; else ok "n claude never started"; fi
finish_case n

# ------------------- o. past deadline_epoch+1800 and no finished: exits ---
mkcase o 2 1
printf 'pgid=1\nstarted_epoch=%s\ndeadline_epoch=%s\nmode=queue\n' "$(($(date +%s) - 9000))" "$(($(date +%s) - 4000))" >"$ND/run.meta"
start_sup
if wait_for "$ND/supervisor.log" "supervisor exits: past deadline_epoch+1800 with no finished marker" 20 && wait_gone "$SPID" 10; then
  ok "o 'supervisor exits: past deadline_epoch+1800 with no finished marker' logged and the process exited"
else bad "o no exit past the deadline: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "o a tick ran past the deadline"; else ok "o no tick ran"; fi

# ------------- p. SUPERVISE-STOP older than started_epoch is an earlier night's ---
mkcase p 2 1
touch -d "@$(($(date +%s) - 1000))" "$ND/SUPERVISE-STOP"
start_sup
if wait_for "$ND/logs/supervisor-ticks.log" "tick exit=0" 20; then ok "p stale SUPERVISE-STOP (older than started_epoch) ignored: a tick ran"
else bad "p stale SUPERVISE-STOP stopped the supervisor: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
no "p no 'supervisor stopped (SUPERVISE-STOP)' for the stale file" "$ND/supervisor.log" "supervisor stopped (SUPERVISE-STOP)"
rm -f "$ND/SUPERVISE-STOP"
finish_case p

# ------ r. runner dead for good (no runner, watch.status DEAD, relaunch budget spent): exits ---
# Git Bash has no flock: a stub that always acquires the lock = no runner holds run.flock.
mkdir -p "$WT/flockstub"; printf '#!/usr/bin/env bash\nexit 0\n' >"$WT/flockstub/flock"; chmod +x "$WT/flockstub/flock"
deadcase(){ # name relaunch-lines... -> a run with its deadline days away, watch.status DEAD, run.flock unheld
  mkcase "$1" 2 1; shift
  printf 'pgid=1\nstarted_epoch=%s\ndeadline_epoch=%s\nrun_date=2026-10-05\nmode=queue\n' "$(($(date +%s) - 100))" "$(($(date +%s) + 259200))" >"$ND/run.meta"
  printf 'DEAD\n' >"$ND/watch.status"; : >"$ND/run.flock"
  printf '%s\n' "$@" >"$ND/supervise.relaunches"
}
deadcase r '2026-10-05 2026-10-05T01:00:00Z' '2026-10-05 2026-10-05T02:00:00Z'
start_sup "$WT/flockstub"
if wait_for "$ND/supervisor.log" "supervisor exits: runner dead for good" 20 && wait_gone "$SPID" 10; then
  ok "r 'supervisor exits: runner dead for good' logged and the process exited"
else bad "r no exit with a dead runner and the relaunch budget spent: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "r a tick ran although the runner is dead for good"; else ok "r no tick ran"; fi
deadcase r2 '2026-10-04 2026-10-04T01:00:00Z' '2026-10-05 2026-10-05T02:00:00Z'
start_sup "$WT/flockstub"
if wait_for "$ND/logs/supervisor-ticks.log" "tick exit=0" 20; then ok "r2 one relaunch for run_date (the other line is another night's): budget left, a tick ran"
else bad "r2 no tick with one relaunch left: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
no "r2 no 'runner dead for good' exit" "$ND/supervisor.log" "runner dead for good"
finish_case r2

# ---------- q. TERM during a running tick: the supervisor and its tick exit at once ---
mkcase q 10 9 FAKE_SLEEP_TENTHS=300
start_sup
if wait_for "$FD/pid" "" 30 && [ -s "$FD/pid" ]; then
  P=$(cat "$FD/pid"); sleep 0.5
  kill "$SPID" 2>/dev/null
  if wait_gone "$SPID" 3; then ok "q TERM mid-tick: supervisor exited within 3 s"; else bad "q supervisor $SPID still alive 3 s after TERM mid-tick"; fi
  if wait_gone "$P" 3; then ok "q TERM mid-tick: the fake claude it launched exited within 3 s"; else bad "q fake claude $P still alive 3 s after TERM"; kill "$P" 2>/dev/null; fi
  if [ -e "$ND/supervise.pid" ]; then bad "q supervise.pid left after TERM"; else ok "q supervise.pid removed after TERM"; fi
else bad "q the tick never started"; fi

# ------------- s. the gate, one-shot: supervise.sh --check (no pidfile, writes nothing, no claude) ---
NOW=$(date +%s)
iso(){ date -u -d "@$1" +%FT%TZ; }
gcase(){ # name [extra config lines...] -> a HEALTHY gate fixture in ND (runner alive, fresh progress, gh [])
  local name=$1; shift
  mkcase "$name" 2 1
  NOW=$(date +%s)
  printf 'pgid=1\nstarted_epoch=%s\ndeadline_epoch=%s\nrun_date=2026-10-05\nmode=queue\n' "$((NOW - 18000))" "$((NOW + 86400))" >"$ND/run.meta"
  cat >>"$ND/config.env" <<EOS
REPO="o/r"
BASE_BRANCH="dev"
BRANCH_PREFIX="nr"
REQUIRED_CHECK="CI"
SUPERVISE_STALL_MIN="45"
SUPERVISE_FORCE_EVERY_MIN="120"
SUPERVISE_DEADLINE_MIN="60"
EOS
  [ $# -gt 0 ] && printf '%s\n' "$@" >>"$ND/config.env"
  : >"$ND/run.flock"
  printf 'S1|first-story||\nS2|second||\n# S9|commented\n\n' >"$ND/queue.txt"
  : >"$ND/state-2026-10-05.txt"; ln -sfn state-2026-10-05.txt "$ND/state.txt"
  printf '%s START S1 (budget 3600s)\n' "$(iso "$NOW")" >"$ND/logs/runner.log"
  mkdir -p "$ND/wt/S1/src"; : >"$ND/wt/S1/src/a.ts"
  printf 'OK\n' >"$ND/watch.status"
  GPATH=$WT/flockheld
  return 0
}
row(){ printf '%s\n' "$*" >>"$(readlink -f "$ND/state.txt")"; }   # a state row in the file state.txt names
backdate(){ # minutes-ago -> state target, runner.log and the whole story worktree last changed then
  local t=$((NOW - $1 * 60))
  touch -d "@$t" "$(readlink -f "$ND/state.txt")" "$ND/logs/runner.log"
  find "$ND/wt/S1" -exec touch -d "@$t" {} +
}
pr(){ # number head conclusion completed-minutes-ago [status] -> gh.json with that one PR
  printf '[{"number":%s,"headRefName":"%s","statusCheckRollup":[{"__typename":"CheckRun","name":"build","workflowName":"CI","status":"%s","conclusion":"%s","completedAt":"%s"},{"__typename":"CheckRun","name":"lint","workflowName":"Other","status":"COMPLETED","conclusion":"FAILURE","completedAt":"%s"}]}]\n' \
    "$1" "$2" "${5:-COMPLETED}" "$3" "$(iso $((NOW - $4 * 60)))" "$(iso $((NOW - 600 * 60)))" >"$FD/gh.json"
}
gcheck(){ # [VAR=value...] -> OUT, RC of one `supervise.sh --check`
  OUT=$(cd "$WT" && env PATH="$GPATH:$WT/bin:$PATH" FAKE_DIR="$FD" BAJZI_HOME="$BH" "$@" bash "$SUP" --check --config "$ND/config.env" 2>&1); RC=$?
}
healthy(){ if [ "$RC" -eq 1 ] && [ "$OUT" = HEALTHY ]; then ok "$1: HEALTHY (exit 1)"; else bad "$1 — rc $RC, out '$OUT', wanted HEALTHY exit 1"; fi; }
trip(){ # name glob-of-the-whole-output
  # shellcheck disable=SC2254
  case "$OUT" in $2) [ "$RC" -eq 0 ] && { ok "$1: '$OUT' (exit 0)"; return; };; esac
  bad "$1 — rc $RC, out '$OUT', wanted '$2' exit 0"
}

gcase s1
gcheck
healthy "s1 all healthy"
for f in supervisor.log supervise.last-opus supervise.pid; do
  if [ -e "$ND/$f" ]; then bad "s1 --check wrote $f"; else ok "s1 --check wrote no $f"; fi
done
if [ -f "$FD/argv" ]; then bad "s1 --check launched claude"; else ok "s1 --check never launches claude"; fi
pair "s1 ONE gh pr list -R <REPO>" "$FD/gh.argv" -R o/r
pair "s1 gh pr list --base <BASE_BRANCH>" "$FD/gh.argv" --base dev
pair "s1 gh pr list --state open" "$FD/gh.argv" --state open
pair "s1 gh pr list --json number,headRefName,statusCheckRollup" "$FD/gh.argv" --json number,headRefName,statusCheckRollup
printf '%s\n' "$$" >"$ND/supervise.pid"
gcheck
healthy "s1 --check runs next to a live supervisor (takes no pidfile)"
if [ "$(cat "$ND/supervise.pid")" = "$$" ]; then ok "s1 --check left supervise.pid alone"; else bad "s1 --check rewrote supervise.pid"; fi

# 1. the runner
gcase s2; GPATH=$WT/flockstub; gcheck; trip "s2 run.flock unheld" "TRIP runner-dead"
gcase s2b; rm -f "$ND/run.flock"; gcheck; trip "s2b no run.flock" "TRIP runner-dead"
gcase s3; GPATH=$WT/flockerr; gcheck; trip "s3 flock probe error = cannot tell" "TRIP runner-unknown"
if ! command -v flock >/dev/null 2>&1; then
  gcase s3b; mkdir -p "$WT/noflock"; GPATH=$WT/noflock; gcheck; trip "s3b no flock binary = cannot tell" "TRIP runner-unknown"
else ok "s3b skipped: this host has a flock binary (s3 covers cannot-tell)"; fi

# 2. stalled: only state's target, runner.log and the CURRENT story's worktree are progress
gcase s4
mkdir -p "$ND/wt/supervise-fix"; backdate 60
: >"$ND/wt/supervise-fix/new.txt"; : >"$ND/logs/S1.log"; : >"$ND/heartbeat"
gcheck; trip "s4 no progress for 60 min (fresh supervise-* wt, story log, heartbeat ignored)" "TRIP stalled:6[01]m"
: >"$ND/wt/S1/src/b.ts"; gcheck; healthy "s4 a fresh file in the current story's worktree is progress"
printf '%s END S1 rc=0\n' "$(iso "$NOW")" >>"$ND/logs/runner.log"; backdate 60; : >"$ND/wt/S1/src/c.ts"
gcheck; trip "s4 S1 ended: its worktree is no longer probed" "TRIP stalled:6[01]m"
touch "$ND/logs/runner.log"; gcheck; healthy "s4 a fresh runner.log is progress"
backdate 60; touch "$(readlink -f "$ND/state.txt")"; gcheck; healthy "s4 a fresh state file is progress"
gcase s5; backdate 60; date -d '+1 hour' +%s >"$ND/quota-until"
gcheck; healthy "s5 stalled skipped while quota-until is in the future"
date -d '-1 minute' +%s >"$ND/quota-until"; gcheck; trip "s5 quota-until past: stalled again" "TRIP stalled:6[01]m"
gcase s6 'SUPERVISE_STALL_MIN="5"'; backdate 30; gcheck; trip "s6 STALL_MIN=5, 30 min quiet" "TRIP stalled:3[01]m"
gcase s6b 'SUPERVISE_STALL_MIN="120"'; backdate 30; gcheck; healthy "s6b STALL_MIN=120 on the same fixture"

# 3/4. stuck PRs
gcase s7; pr 7 feat/nr-S1-first-story SUCCESS 120; gcheck; trip "s7 night PR green for 2 h" "TRIP pr-green:#7"
gcase s8; pr 8 feat/nr-S1-first-story FAILURE 120; gcheck; trip "s8 night PR red for 2 h" "TRIP pr-red:#8"
gcase s8b; pr 8 feat/nr-S2-second TIMED_OUT 120; gcheck; trip "s8b TIMED_OUT is red" "TRIP pr-red:#8"
gcase s9; pr 7 feat/nr-S1-first-story SUCCESS 120; row "S1 0 $(iso "$NOW")"
gcheck; healthy "s9 parked story (is_done row) never trips"
gcase s9b; pr 7 feat/nr-S1-first-story SUCCESS 120; row "S1 DEFERRED-quota $(iso "$NOW") resets=x"
gcheck; trip "s9b a DEFERRED-* row is not done" "TRIP pr-green:#7"
gcase s9c; pr 10 feat/nr-S10-other SUCCESS 120; row "S1 0 $(iso "$NOW")"; printf 'S10|other||\n' >>"$ND/queue.txt"
gcheck; trip "s9c S1 done does not park S10's PR" "TRIP pr-green:#10"
gcase s10; pr 9 supervise-fix-hook SUCCESS 120; gcheck; trip "s10 the supervisor's own supervise-* PR" "TRIP pr-green:#9"
gcase s11; pr 7 feat/nr-S1-first-story SUCCESS 10; gcheck; healthy "s11 check completed 10 min ago (< STALL_MIN)"
gcase s11b; pr 7 feat/nr-S1-first-story "" 120 IN_PROGRESS; gcheck; healthy "s11b check still running"
gcase s12; pr 7 feat/other-thing SUCCESS 120; gcheck; healthy "s12 not a night PR"
gcase s13; echo 1 >"$FD/gh.rc"; gcheck; trip "s13 gh exits non-zero" "TRIP gh-error"
gcase s13b; echo 'not json' >"$FD/gh.json"; gcheck; trip "s13b gh output unparsable" "TRIP gh-error"

# 5. escalate after the offset
gcase s14; printf '01:00 OK fine\n01:30 ESCALATE need a key\n02:00 OK fine\n' >"$ND/triage.log"
gcheck; trip "s14 ESCALATE, offset 0" "TRIP escalate"
gcheck SUPERVISE_ESCALATE_FROM=1; trip "s14 ESCALATE on line 2, offset 1" "TRIP escalate"
gcheck SUPERVISE_ESCALATE_FROM=2; healthy "s14 ESCALATE on line 2, offset 2 (before the offset)"
gcheck SUPERVISE_ESCALATE_FROM=9; trip "s14 offset 9 > 3 lines: reset to 0" "TRIP escalate"

# 6. deadline near with stories left
gcase s15; printf 'pgid=1\nstarted_epoch=%s\ndeadline_epoch=%s\nrun_date=2026-10-05\n' "$((NOW - 18000))" "$((NOW + 1800))" >"$ND/run.meta"
gcheck; trip "s15 30 min left, 2 stories open" "TRIP deadline:[23][90]m-left:2"
row "S1 0 $(iso "$NOW")"; row "S2 BLOCKED-brief $(iso "$NOW")"; gcheck; healthy "s15 30 min left, every story done"

# 7. watch.status
gcase s16; printf 'STALLED\n' >"$ND/watch.status"; gcheck; trip "s16 watch.status STALLED" "TRIP watch:STALLED"
printf 'QUOTA-WAIT\n' >"$ND/watch.status"; gcheck; healthy "s16 watch.status QUOTA-WAIT"
rm -f "$ND/watch.status"; gcheck; healthy "s16 watch.status absent"

# 8. forced
gcase s17; echo $((NOW - 180 * 60)) >"$ND/supervise.last-opus"; gcheck; trip "s17 last Opus tick 3 h ago" "TRIP forced:18[01]m"
echo $((NOW - 30 * 60)) >"$ND/supervise.last-opus"; gcheck; healthy "s17 last Opus tick 30 min ago"
echo $((NOW - 360 * 60)) >"$ND/supervise.last-opus"; gcheck; healthy "s17 last-opus older than started_epoch ignored (an earlier night's)"
gcase s18 'SUPERVISE_FORCE_EVERY_MIN="0"'; rm -f "$FD/gh.argv"; gcheck; trip "s18 FORCE_EVERY_MIN=0: the gate is off" "TRIP forced:gate-off"
if [ -f "$FD/gh.argv" ]; then bad "s18 gate off still called gh"; else ok "s18 gate off calls no gh"; fi
gcase s19; GPATH=$WT/flockstub; printf 'DEAD\n' >"$ND/watch.status"; gcheck; trip "s19 several trips, in order" "TRIP runner-dead watch:DEAD"
( cd "$WT" && bash "$SUP" --help >"$WT/help.out" 2>&1 )
yes "s --help documents --check" "$WT/help.out" "--check"
yes "s --help documents supervise.last-opus" "$WT/help.out" "supervise.last-opus"

# ------------------------------- t. the gate in the loop ---
gcase t1
start_sup "$WT/flockheld"
if wait_for "$ND/supervisor.log" "OK healthy (gate: no trip, last Opus tick 0 min ago)" 20; then ok "t1 healthy: 'OK healthy (gate: no trip, last Opus tick 0 min ago)'"
else bad "t1 no OK healthy: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "t1 claude ran on a healthy gate"; else ok "t1 claude never ran"; fi
if [ -e "$ND/supervise.last-opus" ]; then bad "t1 supervise.last-opus written without a tick"; else ok "t1 no supervise.last-opus"; fi
finish_case t1

gcase t2; printf 'STALLED\n' >"$ND/watch.status"
start_sup "$WT/flockheld"
if wait_for "$ND/supervisor.log" "GATE trip watch:STALLED" 20 && wait_for "$ND/logs/supervisor-ticks.log" "tick exit=0" 20; then
  ok "t2 'GATE trip watch:STALLED', then the tick ran"
else bad "t2 no trip + tick: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
L=$(tr -dc '0-9' <"$ND/supervise.last-opus" 2>/dev/null)
if [ -n "$L" ] && [ "$L" -ge "$NOW" ]; then ok "t2 supervise.last-opus written ($L)"; else bad "t2 supervise.last-opus '$L'"; fi
finish_case t2

gcase t3; printf 'STALLED\n' >"$ND/watch.status"; rm -f "$ND/SUPERVISE-PROMPT.md"
start_sup "$WT/flockheld"
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED" 20; then ok "t3 tripped tick refused: MISCONFIGURED"; else bad "t3 no MISCONFIGURED: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -e "$ND/supervise.last-opus" ]; then bad "t3 supervise.last-opus written although claude never launched"; else ok "t3 no supervise.last-opus on MISCONFIGURED"; fi
finish_case t3

gcase t5; printf 'STALLED\n' >"$ND/watch.status"; : >"$ND/supervise"   # a FILE: tick_launch cannot write its .pid
start_sup "$WT/flockheld"
if wait_for "$ND/supervisor.log" "SUPERVISE MISCONFIGURED no init record" 20; then ok "t5 tick_launch refused: 'SUPERVISE MISCONFIGURED no init record'"
else bad "t5 no refusal: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ -f "$FD/argv" ]; then bad "t5 claude ran although its pid file could not be written"; else ok "t5 claude never started"; fi
if [ -e "$ND/supervise.last-opus" ]; then bad "t5 supervise.last-opus written although claude never started"; else ok "t5 no supervise.last-opus when tick_launch refuses"; fi
finish_case t5

gcase t4; printf '01:30 ESCALATE from an earlier night\n' >"$ND/triage.log"
start_sup "$WT/flockheld"
if wait_for "$ND/supervisor.log" "OK healthy" 20; then ok "t4 an ESCALATE older than the supervisor's start does not trip"
else bad "t4 no OK healthy: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
printf '02:00 ESCALATE tonight\n' >>"$ND/triage.log"
if wait_for "$ND/supervisor.log" "GATE trip escalate" 20 && wait_for "$ND/logs/supervisor-ticks.log" "tick exit=0" 20; then ok "t4 a new ESCALATE trips and the tick runs"
else bad "t4 no escalate trip: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
END=$((SECONDS + 20))
until awk '/GATE trip escalate/{t=1} t && /OK healthy/{f=1} END{exit !f}' "$ND/supervisor.log" 2>/dev/null || [ "$SECONDS" -ge "$END" ]; do sleep 0.1; done
if awk '/GATE trip escalate/{t=1} t && /OK healthy/{f=1} END{exit !f}' "$ND/supervisor.log" 2>/dev/null; then ok "t4 the offset advanced with the tick: healthy again after it"
else bad "t4 never healthy after the escalate tick: $(tr '\n' '|' <"$ND/supervisor.log" 2>/dev/null)"; fi
if [ "$(grep -c 'GATE trip escalate' "$ND/supervisor.log")" -eq 1 ]; then ok "t4 the escalate tripped once"; else bad "t4 escalate tripped $(grep -c 'GATE trip escalate' "$ND/supervisor.log") times"; fi
finish_case t4

# --------------------------------- m. the prompt template renders fully ---
T=$SKILL/templates/SUPERVISE-PROMPT.md.tmpl
if [ -f "$T" ]; then
  sed -e 's|{{PROJECT}}|demo|g' -e 's|{{NIGHT_DIR}}|/nr/demo|g' -e 's|{{BASE}}|/w/demo-night|g' \
      -e 's|{{REPO}}|o/demo|g' -e 's|{{BASE_BRANCH}}|dev|g' -e 's|{{STATE_FILE}}|/nr/demo/night-watch-state.md|g' \
      -e 's|{{REQUIRED_CHECK}}|CI|g' -e 's|{{WATCH_MAX_RESTARTS}}|2|g' -e 's|{{DISK_FLOOR_GB}}|20|g' \
      -e 's|{{LAUNCH_LINE}}|setsid nohup bash /p/run.sh --config /nr/demo/config.env --date 2026-10-05|g' \
      "$T" >"$WT/rendered.md"
  no "m rendered SUPERVISE-PROMPT.md has no '{{'" "$WT/rendered.md" "{{"
  for p in PROJECT NIGHT_DIR BASE REPO BASE_BRANCH STATE_FILE REQUIRED_CHECK WATCH_MAX_RESTARTS DISK_FLOOR_GB LAUNCH_LINE; do
    yes "m template uses {{$p}}" "$T" "{{$p}}"
    yes "m SKILL.md PHASE C names {{$p}} for SUPERVISE-PROMPT.md" "$SKILL/SKILL.md" "{{$p}}"
  done
  for w in Andras Forest /home/ubuntu innotel claude-opus- 'claude -p'; do no "m template has no '$w'" "$T" "$w"; done
  # Relaunch guards that tier 0 has and launch.sh lacks (a bare --deadline rolls forward).
  yes "m relaunch also when tier 0 says DEAD (run.sh deletes watch.restarts)" "$T" "watch.status\` reads \`DEAD\`"
  yes "m relaunch refused within 600 s of deadline_epoch" "$T" "deadline_epoch\` in \`{{NIGHT_DIR}}/run.meta\` minus 600"
  # The relaunch line pins --date "<RUN_DATE>": a post-midnight relaunch continues the same night, so
  # the guard compares the line's --date with run_date, never today's date.
  yes "m relaunch only when the relaunch line's --date is the run's own run_date" "$T" "the \`--date\` value in the relaunch line above equals \`run_date\`"
  no "m the supervisor never relaunches through launch.sh (the owner's bedtime command)" "$T" "bash {{NIGHT_DIR}}/launch.sh"
  yes "m a post-midnight relaunch is allowed" "$T" "a relaunch after local midnight continues the same night"
  no "m no today's-date guard left (it blocked every post-midnight relaunch)" "$T" "\`date +%F\` equals \`run_date\`"
  no "m no 'launch.sh passes no --date' left" "$T" "passes no \`--date\`"
  no "m no 'relaunch carries no --date' left" "$T" "carries no \`--date\`"
  yes "m relaunch budget counted per run_date" "$T" "count only the lines that start with tonight's \`run_date\`"
  yes "m SKILL.md renders it to <NIGHT_DIR>/SUPERVISE-PROMPT.md" "$SKILL/SKILL.md" "<NIGHT_DIR>/SUPERVISE-PROMPT.md"
  yes "m the fix branch is named supervise-<short> (the gate recognises its PRs by that head)" "$T" "a branch named \`supervise-<short>\`"
else bad "m $T not found"; fi

# ------------------------------------------------------------- teardown -----
mine(){ { tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || ps -p "$1" -o args= 2>/dev/null; } | grep -qF -- "${WT##*/}"; }
LEFT=""
for p in $MY_PIDS; do
  if kill -0 "$p" 2>/dev/null; then LEFT="$LEFT $p"; kill "$p" 2>/dev/null; fi
done
if [ -n "$LEFT" ]; then bad "teardown: supervisor survived:$LEFT"; else ok "teardown: every supervisor started here has exited"; fi
STRAY=""
for d in /proc/[0-9]*; do
  q=${d#/proc/}; [ "$q" = "$$" ] && continue
  mine "$q" && { STRAY="$STRAY $q"; kill -KILL "$q" 2>/dev/null; }
done
if [ -n "$STRAY" ]; then bad "teardown: stray processes mentioning the scratch path:$STRAY"; else ok "teardown: no process mentions the scratch path"; fi
rm -rf "$WT" 2>/dev/null

if [ $FAILED -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAILED
