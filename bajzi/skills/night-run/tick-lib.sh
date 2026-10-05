# tick-lib.sh — SOURCED, never run: the code night-watch.sh (tier-1 triage tick) and supervise.sh
# (30-minute supervisor tick) share. One copy, so a fix to the fail-closed launch reaches both.
#
# The caller provides:
#   say()            prints one timestamped line on stdout
#   PROG CONFIG CONFIG_ABS NIGHT_DIR    for the single-instance check
#   TICK_LABEL       message prefix: TICK (triage) or SUPERVISE (supervisor)
#   TICK_LOG         file the verdict lines (MISCONFIGURED / FAILED / CONFIG OK) are appended to
#   TICK_RESULT_LOG  file the tick's decoded result text is appended to
#   TICK_ENV         optional array prefix for the claude exec (supervise.sh: `env -u ...`)

tick_say(){ say "$*"; say "$*" >>"$TICK_LOG" 2>/dev/null; }

# ---------------------------------------------------------- single instance ---
# Two copies on one NIGHT_DIR would double every action. A stale pid file is not a reason to
# refuse: only a LIVE copy of THIS script for THIS run is.
# BOTH halves are required. "cmdline CONTAINS night-watch.sh" is not a watcher: a renamed sleep,
# an editor or a grep matched it and blocked every new watcher on the machine. So: some argv
# element's BASENAME must be exactly $PROG AND the process must name the same config (or the same
# NIGHT_DIR) as we do.
is_our_instance(){ # pid -> 0 when pid is a live $PROG for THIS run
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
claim_pidfile(){ # pidfile -> exits 0 when a live copy already owns it, else writes $$ into it
  local pf=$1 other
  if [ -f "$pf" ]; then
    other=$(head -1 "$pf" 2>/dev/null | tr -dc '0-9')
    if [ -n "$other" ] && [ "$other" != "$$" ]; then
      if is_our_instance "$other"; then
        say "another $PROG is already watching $NIGHT_DIR (pid $other) — exiting."
        exit 0
      fi
      say "$pf holds pid $other, which is not a live $PROG for this run — taking it over."
    fi
  fi
  printf '%s\n' "$$" >"$pf" 2>/dev/null || say "WARNING: could not write $pf"
}

# --------------------------------------------------------------- the model ---
# Supported: the family aliases sonnet|opus|haiku (init id starts claude-<alias>) and full claude-* ids.
# Anything else (opusplan, sonnet[1m], default, provider ids) cannot be matched to the init id: refuse.
# Sets TICK_WANT, never prints it: a $(...) capture would swallow the say() of the refusal.
tick_want(){ # name value -> TICK_WANT = the init-model prefix to demand; rc 1 (logged) when unsupported
  TICK_WANT=""
  case "$2" in
    sonnet|opus|haiku) TICK_WANT=claude-$2;;
    claude-*) TICK_WANT=$2;;
    *) tick_say "$TICK_LABEL MISCONFIGURED unsupported $1=$2 (use sonnet|opus|haiku or a full claude-* id)"; return 1;;
  esac
}

# THE TICK'S INIT RECORD, CHECKED AS THE STREAM ARRIVES — FAIL CLOSED. A tick may commit a fix, so a
# tick on the wrong model or permission mode must not get to act: the first stream line with
# "type":"system" and "subtype":"init" (NOT line 1 — the hook lines come first) must say
# permissionMode=bypassPermissions and a model starting with <want>. On a mismatch the claude
# process is killed at once and nothing it said reaches TICK_RESULT_LOG; a stream with no init
# record, or an init field that cannot be read, is a mismatch too. bash `read`, not awk: mawk
# buffers a pipe until 4 KB or EOF, so it would see the init only after the damage.
# Returns 0 after a good init, 2 after a MISCONFIGURED verdict (already logged).
tick_scan(){ # want raw pidfile < the tick's stream-json on stdin
  local want=$1 raw=$2 pidf=$3 line model perm res tp i err=${3%.pid}.err
  err_note(){ printf 'stderr in %s: %s' "$err" "$(head -c 300 "$err" 2>/dev/null | tr '
' ' ')"; }
  local re_sys='"type"[[:space:]]*:[[:space:]]*"system"' re_init='"subtype"[[:space:]]*:[[:space:]]*"init"'
  local re_model='"model"[[:space:]]*:[[:space:]]*"([^"]*)"'
  local re_perm='"permissionMode"[[:space:]]*:[[:space:]]*"([^"]*)"'
  local re_res='"result"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >>"$raw"
    [[ $line =~ $re_sys && $line =~ $re_init ]] || continue
    model="?"; perm="?"
    [[ $line =~ $re_model ]] && model=${BASH_REMATCH[1]}
    [[ $line =~ $re_perm ]] && perm=${BASH_REMATCH[1]}
    if [ "$perm" != bypassPermissions ] || [ "${model#"$want"}" = "$model" ]; then
      # TERM, then wait for the process to be really gone (timeout --kill-after sends KILL if the
      # tick ignores TERM). "tick killed" is logged only once it is confirmed dead.
      tp=$(tr -dc '0-9' <"$pidf" 2>/dev/null)
      if [ -z "$tp" ]; then
        tick_say "$TICK_LABEL MISCONFIGURED model=$model permissionMode=$perm, wanted model=$want* permissionMode=bypassPermissions — NO pid recorded, tick NOT killed, output ignored ($raw)"
        return 2
      fi
      kill "$tp" 2>/dev/null
      for i in $(seq 1 100); do kill -0 "$tp" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$tp" 2>/dev/null; then
        tick_say "$TICK_LABEL MISCONFIGURED model=$model permissionMode=$perm, wanted model=$want* permissionMode=bypassPermissions — tick pid $tp STILL ALIVE after TERM, NOT confirmed killed, output ignored ($raw)"
      else
        tick_say "$TICK_LABEL MISCONFIGURED model=$model permissionMode=$perm, wanted model=$want* permissionMode=bypassPermissions — tick killed, output ignored ($raw)"
      fi
      return 2
    fi
    cat >>"$raw"                       # the rest of the stream, until the tick ends
    # The final result line's text, JSON-decoded: \" first, then printf %b for \n \t \\ \uXXXX.
    res=$(grep -E '"type"[[:space:]]*:[[:space:]]*"result"' "$raw" | tail -n 1)
    if [[ $res =~ $re_res ]]; then
      res=${BASH_REMATCH[1]}; res=${res//\\\"/\"}
      printf '%b\n' "$res" >>"$TICK_RESULT_LOG"
    else
      tick_say "$TICK_LABEL FAILED no result line in $raw ($(err_note))"
      return 0
    fi
    tick_say "$TICK_LABEL CONFIG OK model=$model permissionMode=$perm"
    return 0
  done
  tick_say "$TICK_LABEL MISCONFIGURED no init record in the stream — output ignored ($raw; $(err_note))"
  return 2
}

# ONE tick, in the foreground of the caller (night-watch.sh backgrounds it, supervise.sh waits):
# prompt on stdin, cwd = <dir>, `timeout --kill-after=3 <sec> claude -p <args...> --output-format
# stream-json --verbose`, the stream checked by tick_scan. Sets TICK_RC to the claude/timeout exit.
tick_launch(){ # dir timeout want raw prompt claude-args...
  local dir=$1 to=$2 want=$3 raw=$4 prompt=$5 rc
  shift 5
  # The middle element records ITS pid, then execs timeout under it: that is the pid tick_scan
  # kills, and timeout passes the signal on to claude (--kill-after: KILL if ignored).
  # No pid file, no claude. A failed cd launches nothing, so the scan finds no init record:
  # still MISCONFIGURED.
  printf '%s' "$prompt" \
    | { printf '%s\n' "$BASHPID" >"${raw%.jsonl}.pid" || { echo "cannot write ${raw%.jsonl}.pid - claude not launched" >&2; exit 1; }
        cd "$dir" && exec ${TICK_ENV[@]+"${TICK_ENV[@]}"} timeout --kill-after=3 "$to" claude -p "$@" \
          --output-format stream-json --verbose; } 2>"${raw%.jsonl}.err" \
    | tick_scan "$want" "$raw" "${raw%.jsonl}.pid"
  rc=("${PIPESTATUS[@]}")
  TICK_RC=${rc[1]}
  # a MISCONFIGURED verdict (scan rc 2) is already logged; any other non-zero exit is a failed tick
  [ "${rc[1]}" -eq 0 ] || [ "${rc[2]}" -eq 2 ] || tick_say "$TICK_LABEL FAILED exit ${rc[1]} (stderr in ${raw%.jsonl}.err)"
  return 0
}
