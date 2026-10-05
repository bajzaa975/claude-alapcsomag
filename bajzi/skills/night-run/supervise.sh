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
#   supervise.sh --check --config <path>            run the gate ONCE: prints `TRIP <reasons>` (exit 0)
#                                                   or `HEALTHY` (exit 1); no pidfile, writes nothing,
#                                                   never launches claude. Next to a live supervisor it
#                                                   uses that one's start and escalate offset (supervise.gate),
#                                                   else a fresh one's (now, triage.log's line count);
#                                                   SUPERVISE_ESCALATE_FROM=<line count> overrides (a test hook)
# run.sh spawns it detached next to night-watch.sh when SUPERVISE=1 (the default), stdout and
# stderr appended to $NIGHT_DIR/logs/supervise.out.
#
# CONFIG KEYS (defaults when absent)
#   SUPERVISE_INTERVAL=1800      seconds; the loop SLEEPS FIRST, then ticks
#   SUPERVISE_TICK_TIMEOUT=1500  hard cap of one tick; must be < SUPERVISE_INTERVAL
#   SUPERVISE_STALL_MIN=45       minutes (>= 1) without progress = stalled; also a stuck PR's age
#   SUPERVISE_FORCE_EVERY_MIN=120  minutes (>= 0): an Opus tick at least this often even when healthy;
#                                0 = gate off, every tick runs Opus (the rollback switch)
#   SUPERVISE_DEADLINE_MIN=60    minutes (>= 1) before deadline_epoch with stories left = a trip
#   NIGHT_DIR                    required; REPO, BASE_BRANCH, BRANCH_PREFIX, REQUIRED_CHECK for the PR trip
#
# EACH ITERATION, after the sleep
#   1. re-read started_epoch from $NIGHT_DIR/run.meta (a relaunch republishes it)
#   2. exit (one line in supervisor.log) when $NIGHT_DIR/SUPERVISE-STOP (not older than the
#      earlier of started_epoch and this supervisor's start: NIGHT_DIR is permanent) or
#      $NIGHT_DIR/STOP exists, $NIGHT_DIR/finished holds an epoch >= started_epoch, or it is past
#      run.meta deadline_epoch + 1800 with no such finished (night-watch.sh's EXPIRED), or the runner
#      is dead for good: run.flock unheld (night-watch.sh's probe), watch.status DEAD or absent, and
#      $NIGHT_DIR/supervise.relaunches already holds 2 lines for run.meta's run_date
#   3. the GATE (gate_check: shell only, NEVER an LLM call) lists trip reasons; none = note
#      `OK healthy (gate: no trip, last Opus tick <N> min ago)` and no tick; else note
#      `GATE trip <reasons>` and run the tick below. Trips, in this order:
#        runner-dead / runner-unknown   runner_dead() says no runner / cannot tell (fails toward Opus)
#        stalled:<min>m      nothing newer than SUPERVISE_STALL_MIN among state.txt's TARGET, logs/runner.log
#                            and the CURRENT story's worktree wt/<id> (last `START <id>` in runner.log with
#                            no later `END <id>`); never all of wt/, heartbeat, logs/<id>.log or the
#                            supervisor's own files; skipped while quota-until holds a future epoch
#        pr-green:#<n> / pr-red:#<n>    ONE `gh pr list --limit 500` per check: an open night PR (head
#                            feat/<BRANCH_PREFIX>-<id>-* whose id is in tonight's queue or state file with no
#                            is_done row, or supervise-* created at or after the earlier of started_epoch and
#                            this supervisor's start) whose REQUIRED_CHECK jobs all completed SUCCESS|SKIPPED|
#                            NEUTRAL / any FAILURE|TIMED_OUT|STARTUP_FAILURE|CANCELLED more than
#                            SUPERVISE_STALL_MIN ago; gh-error = gh missing, failed, timed out, unparsable
#        escalate            an ESCALATE line in triage.log after the offset (its line count at start,
#                            moved on when an Opus tick starts on the right model; 0 again when the file shrinks)
#        deadline:<min>m-left:<k>   deadline_epoch within SUPERVISE_DEADLINE_MIN, k queue ids not done
#        watch:<STATUS>      watch.status present and not OK / QUOTA-WAIT
#        forced:<min>m       the last Opus tick (supervise.last-opus if >= the earlier of started_epoch and
#                            this supervisor's start, else this supervisor's start) is SUPERVISE_FORCE_EVERY_MIN
#                            old; forced:gate-off at 0
#   4. the tick: ONE `claude -p` with $NIGHT_DIR/SUPERVISE-PROMPT.md on stdin, cwd BASE,
#      model = entry [0] of the reviewer allow-list read NOW (reviewer-models.js --first),
#      --permission-mode bypassPermissions, --setting-sources user,project, --settings
#      $NIGHT_DIR/supervise.settings.json (the night deny list minus this night's state-file deny,
#      rewritten at every tick by supset.js from $BASE/.claude/settings.local.json, the copy
#      launch.sh installed; a supset.js failure = SUPERVISE MISCONFIGURED <reason>, claude not
#      launched), provider env (ANTHROPIC_*, CC_ROUTER_*, ...) scrubbed so
#      it can never run on GLM, stream-json checked by tick-lib.sh: an init record with another
#      model or permission mode kills the tick (SUPERVISE MISCONFIGURED in supervisor.log).
#
# FILES under $NIGHT_DIR
#   supervisor.log               start/exit lines, SUPERVISE verdicts, and the tick's own one-line
#                                `<ISO> OK|FIXED|PROBLEM <story> <sentence>`
#   logs/supervisor-ticks.log    each tick's decoded result text + `<ISO> tick exit=<rc>`
#   supervise/<epoch>-<pid>.*    raw stream (.jsonl), stderr (.err), tick pid (.pid)
#   supervise.last-opus          epoch of the last tick whose claude started on the right model and
#                                permission mode (the gate's clock)
#   supervise.gate               this supervisor's start and escalate offset, for --check; removed on exit
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
CHECK=0
usage(){ sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --config)  [ $# -ge 2 ] || { echo "$PROG: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    --check)   CHECK=1;;
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
SUPERVISE_STALL_MIN=${SUPERVISE_STALL_MIN:-45}
SUPERVISE_FORCE_EVERY_MIN=${SUPERVISE_FORCE_EVERY_MIN:-120}
SUPERVISE_DEADLINE_MIN=${SUPERVISE_DEADLINE_MIN:-60}
# Whole minutes, read as decimal (10#: a leading 0 is not octal); STALL and DEADLINE >= 1, FORCE >= 0.
for v in SUPERVISE_STALL_MIN SUPERVISE_FORCE_EVERY_MIN SUPERVISE_DEADLINE_MIN; do
  eval "val=\${$v}"; min=1; [ "$v" = SUPERVISE_FORCE_EVERY_MIN ] && min=0
  case "$val" in
    ''|*[!0-9]*) :;;
    *) [ "$((10#$val))" -ge "$min" ] && { eval "$v=$((10#$val))"; continue; };;
  esac
  echo "$PROG: $v must be a whole number of minutes >= $min, got '$val'" >&2; exit 2
done
REPO=${REPO:-}; BASE_BRANCH=${BASE_BRANCH:-}; BRANCH_PREFIX=${BRANCH_PREFIX:-}; REQUIRED_CHECK=${REQUIRED_CHECK:-}

SKILL_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
REVIEWER_MODELS=$SKILL_DIR/../../hooks/node/lib/reviewer-models.js
META=$NIGHT_DIR/run.meta
FINISHED=$NIGHT_DIR/finished
PROMPT=$NIGHT_DIR/SUPERVISE-PROMPT.md
SUP_LOG=$NIGHT_DIR/supervisor.log
TICKS_LOG=$NIGHT_DIR/logs/supervisor-ticks.log
TICK_DIR=$NIGHT_DIR/supervise
PIDFILE=$NIGHT_DIR/supervise.pid
GATE_STATE=$NIGHT_DIR/supervise.gate

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

SUP_START=$(date +%s)
SLEEP_PID=""
TICK_BG=""      # the backgrounded tick subshell, while a tick runs
TICK_PIDF=""    # its .pid file: the pid tick_launch execs timeout (-> claude) under
# shellcheck disable=SC2317  # both run from traps
cleanup(){
  local mine
  if [ -f "$PIDFILE" ]; then
    mine=$(head -1 "$PIDFILE" 2>/dev/null | tr -dc '0-9')
    [ "$mine" = "$$" ] && rm -f "$PIDFILE" "$GATE_STATE"
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
  local st fin dl ws rd n
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
  # A runner dead for good: every further tick is Opus spend with nothing left to act on (a
  # multi-day deadline is days away). Only when every fact is readable; "cannot tell" keeps ticking.
  if runner_dead; then
    ws=$(head -1 "$NIGHT_DIR/watch.status" 2>/dev/null | tr -dc 'A-Z-')
    rd=$(sed -n 's/^run_date=//p' "$META" 2>/dev/null | tail -1 | tr -dc '0-9-')
    if [ -n "$rd" ] && { [ ! -e "$NIGHT_DIR/watch.status" ] || [ "$ws" = DEAD ]; }; then
      n=$(grep -c "^$rd " "$NIGHT_DIR/supervise.relaunches" 2>/dev/null); n=${n:-0}
      if [ "$n" -ge 2 ]; then
        note "supervisor exits: runner dead for good (run.flock unheld, watch.status ${ws:-absent}, $n/2 supervisor relaunches used for run_date $rd)"
        return 0
      fi
    fi
  fi
  return 1
}

# 0 = provably no runner, judged like night-watch.sh probe_runner: no run.flock, or `flock -n` on it
# succeeds (released at once — a probe, never a hold). 1 = a runner holds it (-E 75 keeps a conflict
# apart from an open/usage error). No flock binary or a probe error = 2 (cannot tell).
runner_dead(){
  local f=$NIGHT_DIR/run.flock rc
  [ -e "$f" ] || return 0
  command -v flock >/dev/null 2>&1 || return 2
  flock -n -E 75 "$f" true 2>/dev/null; rc=$?
  case $rc in 0) return 0;; 75) return 1;; *) return 2;; esac
}

# ------------------------------------------------------------------------------------- the gate ---
# Zero tokens: files, flock, ONE gh call, never an LLM. Fails toward Opus: what it cannot read trips.
LAST_OPUS=$NIGHT_DIR/supervise.last-opus
TRIAGE_LOG=$NIGHT_DIR/triage.log
RUNNER_LOG=$NIGHT_DIR/logs/runner.log
lines(){ local n; n=$(wc -l 2>/dev/null <"$1" | tr -dc '0-9'); printf '%s' "${n:-0}"; }
state_file(){ readlink -f "$NIGHT_DIR/state.txt" 2>/dev/null || printf '%s' "$NIGHT_DIR/state.txt"; }
# run.sh's is_done: a row for the id whose 2nd column does not start with DEFERRED-
is_done(){ awk -v id="$1" '$1==id && $2 !~ /^DEFERRED-/ {found=1} END{exit !found}' "$(state_file)" 2>/dev/null; }
queue_ids(){ # run.sh's queue parse: the first `|` field, trimmed; blank and # lines skipped
  local id rest
  [ -f "$NIGHT_DIR/queue.txt" ] || return 0
  while IFS='|' read -r id rest || [ -n "${id:-}" ]; do
    id=${id#"${id%%[![:space:]]*}"}; id=${id%"${id##*[![:space:]]}"}
    case "$id" in ''|\#*) continue;; esac
    printf '%s\n' "$id"
  done <"$NIGHT_DIR/queue.txt"
}
current_story(){ awk '$2=="START"{c=$3} $2=="END" && $3==c {c=""} END{print c}' "$RUNNER_LOG" 2>/dev/null; }
run_floor(){ # the earlier of started_epoch and this supervisor's start (a relaunch rewrites started_epoch
  # while this supervisor keeps running); empty when started_epoch is unreadable
  local st; st=$(started_epoch)
  [ -n "$st" ] || return 0
  if [ "$st" -lt "$SUP_START" ]; then printf '%s' "$st"; else printf '%s' "$SUP_START"; fi
}
last_opus(){ # supervise.last-opus when it belongs to this run (>= run_floor), else this supervisor's start
  local l fl
  l=$(head -1 "$LAST_OPUS" 2>/dev/null | tr -dc '0-9'); fl=$(run_floor)
  if [ -n "$l" ] && { [ -z "$fl" ] || [ "$l" -ge "$fl" ]; }; then printf '%s' "$l"; else printf '%s' "$SUP_START"; fi
}
pr_story(){ # head -> the LONGEST queue/state id it carries as feat/<prefix>-<id>- (S1 never claims S10's PR)
  local best="" id
  while read -r id; do
    [ -n "$id" ] || continue
    case "$1" in "feat/$BRANCH_PREFIX-$id-"*) [ "${#id}" -gt "${#best}" ] && best=$id;; esac
  done < <(queue_ids; awk '{print $1}' "$(state_file)" 2>/dev/null)
  printf '%s' "$best"
}
# gh JSON on stdin -> one `<number> <head> green|red <createdAt epoch|?>` line per PR whose REQUIRED_CHECK runs (CheckRuns,
# matched on workflowName, else name; the newest entry per job) finished before GATE_CUTOFF.
# shellcheck disable=SC2016  # JavaScript, not shell
PR_JS='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const prs=JSON.parse(s),want=process.env.GATE_CHECK,cut=Number(process.env.GATE_CUTOFF);
  if(!Array.isArray(prs))process.exit(3);
  const t=x=>{const v=Date.parse(x||"")/1000;return v>946684800?v:NaN;};
  for(const p of prs){
    const jobs={};
    for(const e of p.statusCheckRollup||[]){
      if(!e||e.__typename==="StatusContext"||(e.workflowName||e.name)!==want)continue;
      const k=e.name||"",o=jobs[k];
      if(!o||(t(e.startedAt)||t(e.completedAt)||0)>=(t(o.startedAt)||t(o.completedAt)||0))jobs[k]=e;
    }
    const js=Object.values(jobs);if(!js.length)continue;
    const done=e=>e.status==="COMPLETED"&&t(e.completedAt)<cut;
    const c=t(p.createdAt)||"?";
    if(js.some(e=>done(e)&&["FAILURE","TIMED_OUT","STARTUP_FAILURE","CANCELLED"].includes(e.conclusion)))console.log(p.number,p.headRefName,"red",c);
    else if(js.every(e=>done(e)&&["SUCCESS","SKIPPED","NEUTRAL"].includes(e.conclusion)))console.log(p.number,p.headRefName,"green",c);
  }});'
pr_trips(){ # cutoff -> pr-green:#n / pr-red:#n tokens, or gh-error
  local js out="" n head v c id fl
  command -v gh >/dev/null 2>&1 || { printf 'gh-error'; return; }
  if ! js=$(timeout 60 gh pr list -R "$REPO" --base "$BASE_BRANCH" --state open --limit 500 --json number,headRefName,createdAt,statusCheckRollup 2>/dev/null) ||
     ! js=$(printf '%s' "$js" | GATE_CHECK="$REQUIRED_CHECK" GATE_CUTOFF="$1" node -e "$PR_JS" 2>/dev/null); then
    printf 'gh-error'; return
  fi
  fl=$(run_floor)
  while read -r n head v c; do
    [ -n "$n" ] || continue
    case "$head" in
      # an earlier night's supervise-* PR (created before this run) is not tonight's; undatable counts
      supervise-*) case "$c" in ''|*[!0-9]*) :;; *) [ -n "$fl" ] && [ "$c" -lt "$fl" ] && continue;; esac;;
      # an id in neither tonight's queue nor its state file is an earlier night's PR
      "feat/$BRANCH_PREFIX-"*) id=$(pr_story "$head"); { [ -z "$id" ] || is_done "$id"; } && continue;;
      *) continue;;
    esac
    out="$out pr-$v:#$n"
  done <<<"$js"
  printf '%s' "${out# }"
}
# Prints the space-separated trip reasons; empty = healthy. ESC_OFF = the escalate line offset.
gate_check(){
  local now out="" t newest=0 m f id cutoff q dl left k lo ws rc
  if [ "$SUPERVISE_FORCE_EVERY_MIN" -eq 0 ]; then echo forced:gate-off; return 0; fi
  now=$(date +%s)
  runner_dead; rc=$?
  case $rc in 0) out="$out runner-dead";; 2) out="$out runner-unknown";; esac
  cutoff=$((now - SUPERVISE_STALL_MIN * 60))
  q=$(tr -dc '0-9' 2>/dev/null <"$NIGHT_DIR/quota-until")
  if [ -z "$q" ] || [ "$q" -le "$now" ]; then
    for f in "$(state_file)" "$RUNNER_LOG"; do
      m=$(stat -c %Y "$f" 2>/dev/null | tr -dc '0-9')
      [ -n "$m" ] && [ "$m" -gt "$newest" ] && newest=$m
    done
    if [ "$newest" -le "$cutoff" ]; then
      id=$(current_story)
      case "$id" in ''|.|..|*/*) id="";; esac
      if [ -z "$id" ] || [ ! -d "$NIGHT_DIR/wt/$id" ] ||
         [ -z "$(find "$NIGHT_DIR/wt/$id" -newermt "@$cutoff" -print -quit 2>/dev/null)" ]; then
        if [ "$newest" -gt 0 ]; then out="$out stalled:$(((now - newest) / 60))m"; else out="$out stalled:?m"; fi
      fi
    fi
  fi
  t=$(pr_trips "$cutoff"); [ -n "$t" ] && out="$out $t"
  k=$(lines "$TRIAGE_LOG"); m=$ESC_OFF; [ "$k" -lt "$m" ] && m=0
  tail -n +"$((m + 1))" "$TRIAGE_LOG" 2>/dev/null | grep -qw ESCALATE && out="$out escalate"
  dl=$(sed -n 's/^deadline_epoch=//p' "$META" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "$dl" ]; then
    left=$((dl - now))
    if [ "$left" -gt 0 ] && [ "$left" -le $((SUPERVISE_DEADLINE_MIN * 60)) ]; then
      k=0
      while read -r id; do is_done "$id" || k=$((k + 1)); done < <(queue_ids)
      [ "$k" -ge 1 ] && out="$out deadline:$((left / 60))m-left:$k"
    fi
  fi
  if [ -e "$NIGHT_DIR/watch.status" ]; then
    ws=$(head -1 "$NIGHT_DIR/watch.status" 2>/dev/null | tr -dc 'A-Z-')
    case "$ws" in OK|QUOTA-WAIT) :;; *) out="$out watch:${ws:-UNKNOWN}";; esac
  fi
  lo=$(last_opus)
  [ $((now - lo)) -ge $((SUPERVISE_FORCE_EVERY_MIN * 60)) ] && out="$out forced:$(((now - lo) / 60))m"
  printf '%s\n' "${out# }"
}

# 0 when the raw stream's FIRST init record passes tick_scan's check (bypassPermissions, model starting
# with want): tick_scan writes that line to the stream before it kills a misconfigured tick.
init_ok(){ # raw want
  local line model="" perm=""
  local re_sys='"type"[[:space:]]*:[[:space:]]*"system"' re_init='"subtype"[[:space:]]*:[[:space:]]*"init"'
  local re_model='"model"[[:space:]]*:[[:space:]]*"([^"]*)"' re_perm='"permissionMode"[[:space:]]*:[[:space:]]*"([^"]*)"'
  [ -n "$2" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ $re_sys && $line =~ $re_init ]] || continue
    [[ $line =~ $re_model ]] && model=${BASH_REMATCH[1]}
    [[ $line =~ $re_perm ]] && perm=${BASH_REMATCH[1]}
    [ "$perm" = bypassPermissions ] && [ -n "$model" ] && [ "${model#"$2"}" != "$model" ]
    return
  done <"$1"
  return 1
}

tick(){
  local model raw why settings=$NIGHT_DIR/supervise.settings.json
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
  # Never unsandboxed: the night deny list passed explicitly, minus only this night's state-file deny
  # (the re-queue duty deletes a state row). supset.js rewrites supervise.settings.json at EVERY tick
  # from the copy launch.sh installed in BASE, so it can never drift from the night's settings; a
  # failure refuses the tick. cwd = BASE, so repo-relative and **/ denies are anchored at the
  # checkout; --setting-sources user,project keeps BASE's own settings.local.json (which still holds
  # the state deny) from being merged back in.
  # MEASURED 2026-10-05, Claude Code 2.1.289: 'claude -p --model haiku --permission-mode
  # bypassPermissions --settings <file>', cwd holding .claude/settings.local.json with a deny, user
  # ~/.claude/settings.json denying Read(.env). With --setting-sources user,project: the local deny
  # NOT applied, the --settings deny and the user .env deny applied. With --setting-sources '': local
  # not applied, --settings applied, user .env deny NOT applied (so '' is not used). Without
  # --setting-sources: local, --settings and user denies all applied.
  [ -d "$BASE" ] || { tick_say "SUPERVISE MISCONFIGURED BASE is not a directory: $BASE — claude not launched"; return 0; }
  if ! why=$(node "$SKILL_DIR/supset.js" "$BASE/.claude/settings.local.json" "$NIGHT_DIR" "$settings" 2>&1); then
    tick_say "SUPERVISE MISCONFIGURED $(printf '%s' "$why" | tr '\n' ' ') — claude not launched"
    return 0
  fi
  # The gate's clock and escalate offset move only when claude actually started on the right model
  # and permission mode (init_ok; tick_launch can still refuse, tick_scan can kill it), with the
  # values taken at launch: an ESCALATE written during the tick stays visible to the next gate.
  local at esc
  at=$(date +%s); esc=$(lines "$TRIAGE_LOG")
  mkdir -p "$TICK_DIR" "${TICKS_LOG%/*}" 2>/dev/null
  raw=$TICK_DIR/$(date +%s)-$$.jsonl
  # Backgrounded and waited for, like the sleep: a foreground tick would hold a trapped TERM/INT
  # until it ended (up to SUPERVISE_TICK_TIMEOUT); on_signal kills it instead.
  TICK_PIDF=${raw%.jsonl}.pid
  ( TICK_RC=""
    tick_launch "$BASE" "$SUPERVISE_TICK_TIMEOUT" "$TICK_WANT" "$raw" "$(cat "$PROMPT")" \
      --model "$model" --permission-mode bypassPermissions --setting-sources user,project --settings "$settings"
    exit "${TICK_RC:-1}" ) 9>&- &
  TICK_BG=$!
  wait "$TICK_BG"
  TICK_RC=$?
  TICK_BG=""; TICK_PIDF=""
  if init_ok "$raw" "$TICK_WANT"; then
    printf '%s\n' "$at" >"$LAST_OPUS" 2>/dev/null
    ESC_OFF=$esc; publish_gate
  fi
  say "tick exit=$TICK_RC" >>"$TICKS_LOG"
}

# The loop publishes its start and escalate offset, so --check judges like the live supervisor.
publish_gate(){
  printf 'sup_start=%s\nesc_off=%s\n' "$SUP_START" "$ESC_OFF" >"$GATE_STATE.tmp" 2>/dev/null &&
    mv -f "$GATE_STATE.tmp" "$GATE_STATE" 2>/dev/null
}

if [ "$CHECK" -eq 1 ]; then   # one gate run: no pidfile, no log, no last-opus, no claude
  # A live supervisor's published start and offset; without one, what a fresh supervisor would see
  # (offset = the current line count, start = now).
  ESC_OFF=""
  p=$(head -1 "$PIDFILE" 2>/dev/null | tr -dc '0-9')
  if [ -n "$p" ] && is_our_instance "$p"; then
    v=$(sed -n 's/^sup_start=//p' "$GATE_STATE" 2>/dev/null | tail -1 | tr -dc '0-9'); [ -n "$v" ] && SUP_START=$v
    ESC_OFF=$(sed -n 's/^esc_off=//p' "$GATE_STATE" 2>/dev/null | tail -1 | tr -dc '0-9')
  fi
  [ -n "$ESC_OFF" ] || ESC_OFF=$(lines "$TRIAGE_LOG")
  case "${SUPERVISE_ESCALATE_FROM:-}" in ''|*[!0-9]*) :;; *) ESC_OFF=$SUPERVISE_ESCALATE_FROM;; esac
  trips=$(gate_check)
  if [ -n "$trips" ]; then echo "TRIP $trips"; exit 0; fi
  echo HEALTHY; exit 1
fi

claim_pidfile "$PIDFILE"
ESC_OFF=$(lines "$TRIAGE_LOG")   # NIGHT_DIR is permanent: lines already there are earlier nights'
publish_gate
note "supervisor started (pid $$, interval ${SUPERVISE_INTERVAL}s, tick timeout ${SUPERVISE_TICK_TIMEOUT}s)"
while :; do
  sleep "$SUPERVISE_INTERVAL" 9>&- &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || :
  SLEEP_PID=""
  should_exit && break
  # gate_check runs in a subshell: a shrunk triage.log restarts the offset here, in the loop
  [ "$(lines "$TRIAGE_LOG")" -lt "$ESC_OFF" ] && { ESC_OFF=0; publish_gate; }
  trips=$(gate_check)
  if [ -n "$trips" ]; then
    note "GATE trip $trips"
    tick
  else
    note "OK healthy (gate: no trip, last Opus tick $((($(date +%s) - $(last_opus)) / 60)) min ago)"
  fi
done
cleanup
exit 0
