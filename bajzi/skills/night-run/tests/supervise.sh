#!/usr/bin/env bash
# tests/supervise.sh — the 30-minute mid-story supervisor (supervise.sh), against a FAKE claude.
#
# supervise.sh sleeps FIRST, then per iteration re-reads run.meta's started_epoch, exits on
# SUPERVISE-STOP / STOP / a `finished` >= started_epoch, else runs ONE fresh headless tick launched
# fail-closed through tick-lib.sh (provider env scrubbed, stream-json init record checked). Every
# case builds its OWN NIGHT_DIR under one scratch tree, with short intervals, a fake `claude` first
# on PATH and BAJZI_HOME pointing at a scratch reviewer allow-list (the real one is never read).
# The parent env carries GLM provider variables on purpose: the fake records its env, and none of
# them may reach it.
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
chmod +x "$WT/bin/claude" "$WT/nodestub/node"

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
  mkdir -p "$ND/logs" "$FD"
  cat >"$ND/config.env" <<EOS
PROJECT="suptest-$name"
NIGHT_DIR="$ND"
SUPERVISE_INTERVAL="$iv"
SUPERVISE_TICK_TIMEOUT="$to"
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
pair "a argv --output-format stream-json" "$A" --output-format stream-json
if grep -qxF -- --verbose "$A" 2>/dev/null; then ok "a argv has --verbose"; else bad "a argv has no --verbose"; fi
GOT=$(cat "$FD/cwd" 2>/dev/null); WANT=$(cd "$ND" && pwd -P)
if [ "$GOT" = "$WANT" ]; then ok "a tick cwd == NIGHT_DIR"; else bad "a tick cwd '$GOT', wanted NIGHT_DIR '$WANT'"; fi
yes "a the rendered prompt reached the tick on stdin" "$FD/stdin" "Supervise prompt for the test."
for v in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_DEFAULT_OPUS_MODEL CC_WORKER_MODE CLAUDECODE; do
  if grep -q "^$v=" "$FD/env" 2>/dev/null; then bad "a provider env $v reached the tick"
  elif [ -s "$FD/env" ]; then ok "a provider env $v scrubbed"; else bad "a fake recorded no env"; fi
done
yes "a decoded result in logs/supervisor-ticks.log" "$ND/logs/supervisor-ticks.log" "SUPERVISE-RESULT OK S1 progressing"
yes "a 'SUPERVISE CONFIG OK' in supervisor.log" "$ND/supervisor.log" "SUPERVISE CONFIG OK model=claude-opus-5-5-20261001 permissionMode=bypassPermissions"
no "a no MISCONFIGURED" "$ND/supervisor.log" "MISCONFIGURED"
RAW=$(ls "$ND"/supervise/*.jsonl 2>/dev/null | head -1)
if [ -n "$RAW" ] && grep -q '"subtype":"init"' "$RAW"; then ok "a raw stream saved under supervise/"; else bad "a no raw stream under $ND/supervise/"; fi
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

# --------------------------------- m. the prompt template renders fully ---
T=$SKILL/templates/SUPERVISE-PROMPT.md.tmpl
if [ -f "$T" ]; then
  sed -e 's|{{PROJECT}}|demo|g' -e 's|{{NIGHT_DIR}}|/nr/demo|g' -e 's|{{BASE}}|/w/demo-night|g' \
      -e 's|{{REPO}}|o/demo|g' -e 's|{{BASE_BRANCH}}|dev|g' -e 's|{{STATE_FILE}}|/nr/demo/night-watch-state.md|g' \
      -e 's|{{REQUIRED_CHECK}}|CI|g' -e 's|{{WATCH_MAX_RESTARTS}}|2|g' -e 's|{{DISK_FLOOR_GB}}|20|g' \
      "$T" >"$WT/rendered.md"
  no "m rendered SUPERVISE-PROMPT.md has no '{{'" "$WT/rendered.md" "{{"
  for p in PROJECT NIGHT_DIR BASE REPO BASE_BRANCH STATE_FILE REQUIRED_CHECK WATCH_MAX_RESTARTS DISK_FLOOR_GB; do
    yes "m template uses {{$p}}" "$T" "{{$p}}"
    yes "m SKILL.md PHASE C names {{$p}} for SUPERVISE-PROMPT.md" "$SKILL/SKILL.md" "{{$p}}"
  done
  for w in Andras Forest /home/ubuntu innotel claude-opus- 'claude -p'; do no "m template has no '$w'" "$T" "$w"; done
  # Relaunch guards that tier 0 has and launch.sh lacks (no --date pin, a bare --deadline rolls forward).
  yes "m relaunch also when tier 0 says DEAD (run.sh deletes watch.restarts)" "$T" "watch.status\` reads \`DEAD\`"
  yes "m relaunch refused within 600 s of deadline_epoch" "$T" "deadline_epoch\` in \`{{NIGHT_DIR}}/run.meta\` minus 600"
  yes "m relaunch only on the run's own run_date" "$T" "\`date +%F\` equals \`run_date\`"
  yes "m relaunch budget counted per run_date" "$T" "count only the lines that start with tonight's \`run_date\`"
  yes "m SKILL.md renders it to <NIGHT_DIR>/SUPERVISE-PROMPT.md" "$SKILL/SKILL.md" "<NIGHT_DIR>/SUPERVISE-PROMPT.md"
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
