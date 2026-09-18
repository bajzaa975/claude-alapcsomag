#!/usr/bin/env bash
# THE night runner — shared by every project, never edited per project.
# One fresh headless `claude -p` session per queue line; all project facts come
# from a config.env (see templates/config.env.tmpl).
#
# Usage:
#   run.sh --config <path/to/config.env> [--dry-run] [--smoke] [--one <id>]
#          [--deadline "<HH:MM|YYYY-MM-DD HH:MM>"] [--report]
#   (--config may be replaced by the NIGHT_CONFIG environment variable.)
#
#   --dry-run   print the generated prompts and exit; launches nothing, takes no lock
#   --smoke     one short session that proves the headless setup works, then exit
#   --one <id>  run only that queue id
#   --deadline  stop before the next story once this moment has passed. Accepts a
#               full timestamp ("2026-09-18 07:30") or a bare H:MM / HH:MM, which
#               means the next occurrence of that time (so 7:30 or 07:30 typed at
#               23:00 is tomorrow morning; both forms behave identically).
#               Compared with `date -d`. A deadline that is still in the past
#               after the roll-forward is REFUSED with a non-zero exit — a night
#               that silently does nothing is the worst outcome.
#   --report    only (re)write REPORT-<date>.md from the logs; a normal run ends
#               with that same report session by itself.
#
#   kill switch: touch $NIGHT_DIR/STOP   (checked between stories)
#
# Every queue line ends up in $NIGHT_DIR/state.txt: either "<id> <exit code>" for
# a story that ran, or "<id> BLOCKED-queue|BLOCKED-needs|DEFERRED-needs <time>
# <reason>" for one that could not. Nothing is ever dropped silently.
#
# LAUNCH IT WITH setsid — this is required, not cosmetic:
#
#   cd <BASE>
#   setsid nohup bash /path/to/run.sh --config ~/night-runs/<project>/config.env \
#     >> ~/night-runs/<project>/logs/console.log 2>&1 &
#
# `nohup` alone is NOT enough: it blocks SIGHUP but not the harness killing the
# launching session's process group, and on 2026-09-18 a runner started that way
# died with the session that launched it. `setsid` gives the runner its own
# session, so it survives.
#
# VERIFY THAT EXACTLY ONE RUNNER IS ALIVE (spec section 5 PHASE A):
#
#   for p in $(pgrep -f 'run\.sh'); do
#     tr '\0' '\n' </proc/$p/cmdline | head -2 | sed 's|.*/||' | grep -qx 'run.sh' \
#       && awk '{print $5}' "/proc/$p/stat"
#   done | sort -u
#
# THIS argv test is the check — do not use a bare pattern match on the command
# line. A genuine runner is a process whose argv NAMES run.sh as the script:
# argv[1] basenames to `run.sh` (`bash /path/run.sh --config ...`), or argv[0]
# does when the script is executed directly (`./run.sh --config ...`). A shell
# that merely mentions run.sh inside a `-c` string has argv[1] == `-c` and is
# excluded, which no text pattern can do reliably. The older documented form
# `pgrep -af "bash .*/run\.sh$"` is WRONG for this runner: it is always launched
# with `--config <path>`, so the `$` anchor never matches; and the relaxed
# `( |$)` form matches the checking shell itself and reports phantom runners.
# Never use a bare `ps` either — on this machine `rtk` rewrites it, the output
# format changes and the pattern silently finds nothing.
#
# One runner = ONE distinct pgid among the matching pids (the parent and its
# subshell are two processes in one group), so compare pgids, not process
# counts; procfs field 5 is the pgid and `rtk` does not touch procfs.
# More than one line means more than one runner: stop and report, never launch.
# $NIGHT_DIR/run.lock carries the live runner's pgid as a second, cheaper check.
# NEVER identify a runner by "is it my own process group": two runners started
# without `setsid` SHARE a process group, each would filter the other out and
# both would run the same story in one worktree on one branch.

set -u

# ---------------------------------------------------------------- arguments --
CONFIG=${NIGHT_CONFIG:-}
DRY=0; SMOKE=0; ONE=""; DEADLINE=""; REPORT_ONLY=0
usage(){
  # The WHOLE header comment block, to stdout: everything from line 2 down to
  # the first line that is not a comment. The setsid requirement and the
  # single-runner check are load-bearing and must never fall outside --help.
  awk 'NR==1{next} /^#/{sub(/^#[[:space:]]?/,""); print; next} {exit}' "$0"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --config)   [ $# -ge 2 ] || { echo "run.sh: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    --dry-run)  DRY=1;;
    --smoke)    SMOKE=1;;
    --one)      [ $# -ge 2 ] || { echo "run.sh: --one needs a story id" >&2; exit 2; }; ONE=$2; shift;;
    --deadline) [ $# -ge 2 ] || { echo "run.sh: --deadline needs a time" >&2; exit 2; }; DEADLINE=$2; shift;;
    --report)   REPORT_ONLY=1;;
    -h|--help)  usage; exit 0;;
    *) echo "run.sh: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
  shift
done

if [ -z "$CONFIG" ]; then
  echo "run.sh: no config — pass --config <path/to/config.env> or set NIGHT_CONFIG." >&2
  echo "run.sh: a template lives next to this script in templates/config.env.tmpl." >&2
  exit 2
fi
[ -f "$CONFIG" ] || { echo "run.sh: config file not found: $CONFIG" >&2; exit 2; }
# shellcheck source=/dev/null
. "$CONFIG"

# --------------------------------------------------------------- the config --
missing=""
for v in NIGHT_DIR BASE REPO BASE_BRANCH MODEL PER_STORY_TIMEOUT PROJECT BRANCH_PREFIX DISK_FLOOR_GB REQUIRED_CHECK GIT_USER_NAME GIT_USER_EMAIL; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "run.sh: $CONFIG is missing required field(s):$missing" >&2
  echo "run.sh: every field in templates/config.env.tmpl must be set." >&2
  exit 2
fi
case "$PER_STORY_TIMEOUT" in *[!0-9]*) echo "run.sh: PER_STORY_TIMEOUT must be whole seconds, got '$PER_STORY_TIMEOUT'" >&2; exit 2;; esac
case "$DISK_FLOOR_GB"     in *[!0-9]*) echo "run.sh: DISK_FLOOR_GB must be a whole number of GB, got '$DISK_FLOOR_GB'" >&2; exit 2;; esac
# Optional, has a default: the bounded CI wait handed to every story session.
CI_WAIT_MINUTES=${CI_WAIT_MINUTES:-45}
case "$CI_WAIT_MINUTES" in ""|*[!0-9]*) echo "run.sh: CI_WAIT_MINUTES must be whole minutes, got '$CI_WAIT_MINUTES'" >&2; exit 2;; esac
[ -d "$NIGHT_DIR" ] || { echo "run.sh: NIGHT_DIR does not exist: $NIGHT_DIR" >&2; exit 2; }
# A dry run prints prompts and launches nothing, so it must not need the base
# worktree to exist; every real mode does.
if [ $DRY -eq 0 ]; then
  [ -d "$BASE" ] || { echo "run.sh: BASE worktree does not exist: $BASE" >&2; exit 2; }
fi

QUEUE=$NIGHT_DIR/queue.txt
BRIEF=$NIGHT_DIR/BRIEF.md
LOGS=$NIGHT_DIR/logs
STATE=$NIGHT_DIR/state.txt          # lines: <id> <rc> <ISO time>
STOP=$NIGHT_DIR/STOP
LOCK=$NIGHT_DIR/run.lock
CLAUDE_BIN=${CLAUDE_BIN:-claude}
PERM_MODE=${PERM_MODE:-auto}        # same mode as an interactive session, plus $BASE/.claude/settings.local.json
RUN_DATE=$(date +%F)
EXTRA=(--model "$MODEL")

mkdir -p "$LOGS" "$NIGHT_DIR/wt"
touch "$STATE"
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGS/runner.log"; }

# ------------------------------------------------------------ the run lock ---
# procfs field 5 of /proc/<pid>/stat is the pgid; comm (field 2) may contain
# spaces, so cut everything up to its closing paren before counting fields.
pgid_of(){
  local st
  st=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  st=${st#*") "}
  # shellcheck disable=SC2086
  set -- $st
  [ $# -ge 3 ] || return 1
  printf '%s\n' "$3"
}
# THE runner identifier, used by every liveness check in this script and
# documented in the header for the owner's PHASE A check. A process IS a runner
# when its argv names run.sh as the script: argv[1] basenames to run.sh
# (`bash /path/run.sh --config ...`) or argv[0] does (`./run.sh --config ...`).
# `bash -c '... run.sh ...'` has argv[1] == "-c" and is correctly excluded.
# Identification is by argv ONLY — never by process group, because two runners
# launched without setsid share one pgid and would each declare the other dead.
is_runner_pid(){
  local pid=$1 a0="" a1=""
  [ -r "/proc/$pid/cmdline" ] || return 1
  { IFS= read -r -d '' a0 || true; IFS= read -r -d '' a1 || true; } <"/proc/$pid/cmdline" 2>/dev/null
  [ -n "$a0" ] || return 1
  [ "${a1##*/}" = "run.sh" ] && return 0
  [ "${a0##*/}" = "run.sh" ] && return 0
  return 1
}
live_runner_pgids(){   # every live runner's pgid, OUR OWN INCLUDED
  local p
  for p in $(pgrep -f 'run\.sh' 2>/dev/null); do
    is_runner_pid "$p" && pgid_of "$p"
  done | sort -u
}
MY_PGID=$(pgid_of $$ || echo "$$")
LOCK_HELD=0
lock_owner(){ head -1 "$LOCK" 2>/dev/null | tr -dc '0-9'; }
# shellcheck disable=SC2317  # invoked from the EXIT/INT/TERM trap
release_lock(){
  [ "$LOCK_HELD" -eq 1 ] || return 0
  LOCK_HELD=0
  local held; held=$(lock_owner)
  if [ "$held" = "$MY_PGID" ]; then
    rm -f "$LOCK"
  else
    # Never delete a lock that now belongs to somebody else.
    log "run.lock holds pgid ${held:-<empty>}, not mine ($MY_PGID) — leaving it in place"
  fi
  return 0
}
acquire_lock(){
  local held try
  for try in 1 2 3; do
    # Atomic create: with noclobber the redirect fails if $LOCK already exists,
    # so two simultaneous starts can never both win.
    if ( set -C; printf '%s\n' "$MY_PGID" >"$LOCK" ) 2>/dev/null; then
      LOCK_HELD=1
      trap release_lock EXIT INT TERM
      log "run.lock taken: pgid $MY_PGID (attempt $try)"
      return 0
    fi
    held=$(lock_owner)
    if [ -n "$held" ] && live_runner_pgids | grep -qx "$held"; then
      echo "run.sh: a runner is already alive for $PROJECT (pgid $held, $LOCK) — refusing to start a second one." >&2
      echo "run.sh: check it with the argv test in the header of this script ($0 --help)." >&2
      exit 3
    fi
    log "stale run.lock (pgid ${held:-unreadable} is not a live run.sh) — taking it over"
    rm -f "$LOCK"
  done
  echo "run.sh: could not take $LOCK after 3 attempts — another starter keeps winning the race; refusing to start." >&2
  exit 3
}

# ----------------------------------------------------------------- helpers ---
DEADLINE_EPOCH=""
log_deadline="none"
if [ -n "$DEADLINE" ]; then
  case "$DEADLINE" in
    # bare H:MM or HH:MM = the next occurrence of that time. A single-digit
    # hour is normalised to two digits first: "7:30" once fell through to the
    # literal branch, was never rolled forward and killed the whole night.
    [0-9]:[0-9][0-9]|[0-9][0-9]:[0-9][0-9])
      DEADLINE_HHMM=$DEADLINE
      case "$DEADLINE_HHMM" in [0-9]:*) DEADLINE_HHMM=0$DEADLINE_HHMM;; esac
      DEADLINE_EPOCH=$(date -d "$DEADLINE_HHMM" +%s 2>/dev/null) || DEADLINE_EPOCH=""
      if [ -n "$DEADLINE_EPOCH" ] && [ "$DEADLINE_EPOCH" -le "$(date +%s)" ]; then
        DEADLINE_EPOCH=$(date -d "tomorrow $DEADLINE_HHMM" +%s 2>/dev/null) || DEADLINE_EPOCH=""
      fi;;
    *)
      DEADLINE_EPOCH=$(date -d "$DEADLINE" +%s 2>/dev/null) || DEADLINE_EPOCH="";;
  esac
  [ -n "$DEADLINE_EPOCH" ] || { echo "run.sh: --deadline '$DEADLINE' is not a time date -d understands" >&2; exit 2; }
  # A deadline still in the past after roll-forward means the run would stop
  # before its first story and report nothing: refuse loudly instead.
  if [ "$DEADLINE_EPOCH" -le "$(date +%s)" ]; then
    echo "run.sh: --deadline '$DEADLINE' resolves to $(date -d "@$DEADLINE_EPOCH" '+%F %T'), which is already past — the run would do nothing. Give a future time." >&2
    exit 2
  fi
  log_deadline="$(date -d "@$DEADLINE_EPOCH" '+%F %T')"
fi
past_deadline(){ [ -n "$DEADLINE_EPOCH" ] && [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; }

free_gb(){ df -BG --output=avail "$BASE" 2>/dev/null | tail -1 | tr -dc '0-9'; }
disk_ok(){
  local g; g=$(free_gb)
  [ -n "$g" ] || return 0            # unknown: do not block the night on df
  [ "$g" -ge "$DISK_FLOOR_GB" ]
}

is_done(){ grep -q "^$1 " "$STATE"; }

trim(){ local s=$1; s=${s#"${s%%[![:space:]]*}"}; s=${s%"${s##*[![:space:]]}"}; printf '%s' "$s"; }

# state.txt rows: "<id> <rc|TOKEN> <ISO time> [reason]". A numeric second field
# is a story that actually ran and its exit code; a TOKEN is a runner-side
# outcome (BLOCKED-queue, BLOCKED-needs, DEFERRED-needs). Every queue line ends
# up with a row — nothing may ever vanish silently from the queue.
record_state(){ # id token [reason...]
  local id=$1 tok=$2; shift 2
  local reason; reason=$*
  if [ -n "$reason" ]; then
    printf '%s %s %s %s\n' "$id" "$tok" "$(date -u +%FT%TZ)" "$reason" >>"$STATE"
  else
    printf '%s %s %s\n' "$id" "$tok" "$(date -u +%FT%TZ)" >>"$STATE"
  fi
}

MERGED_PRS=" "
# 0 = satisfied, 1 = not merged yet (defer), 2 = unusable value (configuration
# error, the caller must BLOCK the story — never silently skip it).
needs_satisfied(){ # <needs column>: '-' (none) or a PR reference that must be MERGED
  local n=$1 num
  case "$n" in
    ""|-|none|NONE) return 0;;
  esac
  # Accept 115, #115, pr115, PR#115, "pr 115": keep the digits, gate on those.
  num=$(printf '%s' "$n" | tr -dc '0-9')
  [ -n "$num" ] || return 2
  case "$MERGED_PRS" in *" $num "*) return 0;; esac
  if gh pr view "$num" -R "$REPO" --json state --jq .state 2>/dev/null | grep -qx MERGED; then
    MERGED_PRS="$MERGED_PRS$num "
    return 0
  fi
  return 1
}

# ------------------------------------------------------- the per-story brief --
# BRIEF.md is rendered by the skill, except for the values only the runner can
# know or must pin. Each story gets its own copy with those substituted.
render_brief(){ # id story_deadline_epoch -> prints the path of the story's brief
  local id=$1 epoch=$2
  local out=$NIGHT_DIR/BRIEF-$id.md
  if [ ! -f "$BRIEF" ]; then printf '%s\n' "$BRIEF"; return 1; fi
  sed -e "s|{{STORY_DEADLINE_EPOCH}}|$epoch|g" \
      -e "s|{{CI_WAIT_MINUTES}}|$CI_WAIT_MINUTES|g" \
      -e "s|{{GIT_USER_NAME}}|$GIT_USER_NAME|g" \
      -e "s|{{GIT_USER_EMAIL}}|$GIT_USER_EMAIL|g" \
      "$BRIEF" >"$out" || { printf '%s\n' "$BRIEF"; return 1; }
  if grep -q '{{[A-Z_]*}}' "$out"; then
    # stderr: this function's stdout is the brief path and nothing else.
    log "WARNING $id: $out still contains unsubstituted placeholder(s): $(grep -o '{{[A-Z_]*}}' "$out" | sort -u | tr '\n' ' ')" >&2
  fi
  printf '%s\n' "$out"
}

# ------------------------------------------------------------ story prompt ---
prompt_for(){ # id slug note brief_path story_deadline_epoch
  cat <<P
Invoke the bajzi:autopilot skill first (scope: $PROJECT story $1 only), then read $4 in full and obey it.
Your hard wall clock cap is $PER_STORY_TIMEOUT seconds: the runner's \`timeout\` kills this session at unix epoch $5 ($(date -d "@$5" '+%F %T %Z')). Compare \`date +%s\` with $5, not a feeling, whenever the brief asks how much time is left. Wait at most $CI_WAIT_MINUTES minutes for CI in total. Commit as $GIT_USER_NAME <$GIT_USER_EMAIL> — a fresh worktree may have no git identity, so pin it with \`git -c user.name='$GIT_USER_NAME' -c user.email='$GIT_USER_EMAIL' commit ...\`.
You are a HEADLESS per-story session started by the shared night runner; there is no orchestrator, so you are BOTH the story agent (BRIEF section 3) and the merge gate (BRIEF section 4) for story $1 and nothing else.
Project: $PROJECT (repo $REPO, base branch $BASE_BRANCH). Required CI check: $REQUIRED_CHECK — only a pull_request-event run of it counts.
Story: $1 — $3
Branch: feat/$BRANCH_PREFIX-$1-$2 in worktree $NIGHT_DIR/wt/$1. Fetch first, then take exactly one case: the path already exists -> continue in it, never recreate; the path is missing but the branch exists locally or on the remote -> git worktree add $NIGHT_DIR/wt/$1 feat/$BRANCH_PREFIX-$1-$2; neither exists -> git worktree add $NIGHT_DIR/wt/$1 -b feat/$BRANCH_PREFIX-$1-$2 origin/$BASE_BRANCH. Append the tree to $NIGHT_DIR/worktrees.tsv as "$1<TAB>path<TAB>branch<TAB>ISO time". Never create a worktree in a deployed tree and never use bare git stash.
Do the story with sub-agents for every heavy step (explore, implement with TDD, run tests, review) so your own context stays small; never read a file over 300 lines yourself.
End the story with the review-and-fix loop: a FRESH, INDEPENDENT Opus 5 sub-agent reviews the diff against origin/$BASE_BRANCH (never your summary of it) and returns VERDICT pass|fail with BLOCKING / NON-BLOCKING findings and an EVIDENCE line; a different sub-agent fixes blocking findings; repeat with a new reviewer, at most 3 rounds. Zero blocking findings = review-green. Still blocking after round 3, or the same finding twice with no change in the diff -> PARK with reason review. Never reach green by deleting or skipping a test, loosening an assertion or lowering a threshold.
When the PR is open, apply the merge gate exactly as written (pull_request-event $REQUIRED_CHECK only, one PR, merge origin/$BASE_BRANCH into the branch first, squash-merge only when the story is BOTH review-green and CI-green; otherwise leave the PR open and PARK it with a reason).
Watch your own context: at roughly half of it stop taking new scope, at roughly 70% finalize — commit what is green, push, open or update the PR, write the handoff and park with reason context.
Then, in $BASE: append a section for $1 to runtime/AUTOPILOT-REPORT.md (PR number, merged or open, tests run and counts, BACKLOG row change, decisions, PARKED/BLOCKED with reasons, what the owner should review), rewrite runtime/handoff/night.md (<= 40 lines), run \`brain note decision: ...\` for each non-trivial decision, and finish with ONE line:
RESULT $1 <merged|open|parked|blocked> PR#<n or -> review=<pass|parked> rounds=<n>
Never ask questions; the owner is asleep. Write everything in English. Exit when done.
P
}

run_story(){ # id slug note
  local id=$1 slug=$2 note=$3 rc prompt epoch brief
  # The absolute moment `timeout` will kill this session; the brief and the
  # prompt both get it, so the session can judge its own remaining time.
  epoch=$(( $(date +%s) + PER_STORY_TIMEOUT ))
  if [ $DRY -eq 1 ]; then
    prompt=$(prompt_for "$id" "$slug" "$note" "$BRIEF" "$epoch")
    printf '=== %s (dry-run) ===\n%s\n\n' "$id" "$prompt"; return 0
  fi
  brief=$(render_brief "$id" "$epoch") || log "WARNING $id: could not render a per-story brief; falling back to $brief"
  prompt=$(prompt_for "$id" "$slug" "$note" "$brief" "$epoch")
  log "START $id (deadline epoch $epoch, brief $brief)"
  ( cd "$BASE" && env -u CLAUDECODE \
      STORY_DEADLINE_EPOCH="$epoch" CI_WAIT_MINUTES="$CI_WAIT_MINUTES" \
      GIT_USER_NAME="$GIT_USER_NAME" GIT_USER_EMAIL="$GIT_USER_EMAIL" \
      GIT_AUTHOR_NAME="$GIT_USER_NAME" GIT_AUTHOR_EMAIL="$GIT_USER_EMAIL" \
      GIT_COMMITTER_NAME="$GIT_USER_NAME" GIT_COMMITTER_EMAIL="$GIT_USER_EMAIL" \
      timeout "$PER_STORY_TIMEOUT" "$CLAUDE_BIN" -p "$prompt" \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/$id.log" 2>&1
  rc=$?
  record_state "$id" "$rc"
  log "END $id rc=$rc $(grep -o 'RESULT .*' "$LOGS/$id.log" | tail -1)"
  return $rc
}

# ------------------------------------------------------------- the report ----
write_report(){ # one more fresh session that consolidates the night into REPORT-<date>.md
  local out=$NIGHT_DIR/REPORT-$RUN_DATE.md rc
  log "REPORT start -> $out"
  ( cd "$BASE" && env -u CLAUDECODE timeout 1800 "$CLAUDE_BIN" -p "Write the night report for the $PROJECT overnight run of $RUN_DATE. Read these with Bash, change nothing else: $STATE; $LOGS/runner.log; the RESULT lines from grep -h 'RESULT ' $LOGS/*.log; $BASE/runtime/AUTOPILOT-REPORT.md; $BASE/runtime/DECISIONS.md if present; gh pr list -R $REPO --state all --limit 20 --json number,title,state,mergedAt,headRefName; and brain next $PROJECT. Write $out in English with: In $STATE a numeric second field is a story that ran and its exit code, while BLOCKED-queue, BLOCKED-needs and DEFERRED-needs are runner-side outcomes with the reason in the rest of the line; every one of them is a queue line that never ran and MUST appear in the table and in section 4, never be omitted. 1) a one-paragraph summary (stories attempted, merged, open, parked, blocked, plus blocked-before-start); 2) one table row per story: id, result, PR, merged or open, review verdict and rounds, tests run; 3) decisions taken on the owner's behalf; 4) PARKED and BLOCKED items with reasons, naming which floor was hit (review, timeout or context); 5) any story reported merged or open with review=parked, flagged as a contradiction; 6) LET'S REVIEW THIS TOGETHER in priority order; 7) worktrees under $NIGHT_DIR/wt that are dirty, unpushed or parked and must be kept; 8) what the Brain recommends next. Then run: update-monitor note \"$PROJECT overnight run $RUN_DATE: <one line with PR numbers>\" and brain note night run $RUN_DATE: <one line>. Finish with the line REPORT WRITTEN $out" \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/report.log" 2>&1
  rc=$?
  log "REPORT rc=$rc $(grep -o 'REPORT WRITTEN .*' "$LOGS/report.log" | tail -1)"
}

finish(){ log "RUN end — state:"; tee -a "$LOGS/runner.log" <"$STATE"; [ $DRY -eq 1 ] || write_report; exit 0; }

# ----------------------------------------------------------------- modes -----
if [ $REPORT_ONLY -eq 1 ]; then acquire_lock; write_report; exit 0; fi
if [ $SMOKE -eq 1 ]; then
  acquire_lock
  log "SMOKE start (project=$PROJECT base=$BASE mode=$PERM_MODE model=$MODEL)"
  ( cd "$BASE" && env -u CLAUDECODE timeout 300 "$CLAUDE_BIN" -p "Run 'brain here' via Bash and then reply with exactly: SMOKE OK <the branch name brain here printed>. Change nothing." \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/smoke.log" 2>&1
  rc=$?; log "SMOKE rc=$rc last line: $(tail -1 "$LOGS/smoke.log")"; exit $rc
fi

[ -f "$QUEUE" ] || { echo "run.sh: queue file not found: $QUEUE" >&2; exit 2; }
if [ $DRY -eq 0 ]; then
  acquire_lock
  disk_ok || { log "REFUSING to start: free disk $(free_gb)G is below DISK_FLOOR_GB=${DISK_FLOOR_GB}G"; exit 4; }
fi

# ------------------------------------------------------------- the queue -----
# Two passes. Pass one runs everything whose `needs` is already satisfied and
# records a state.txt row for every story it starts. Pass two therefore picks up
# ONLY the items pass one never started because their `needs` PR was not merged
# yet — is_done skips anything that already ran, so a story that ran and FAILED
# is never retried the same night; it is reported and re-queued by the next
# /bajzi:night-run.
log "RUN start (project=$PROJECT dry=$DRY one=${ONE:-all} deadline=$log_deadline model=$MODEL ci_wait=${CI_WAIT_MINUTES}m)"
for pass in 1 2; do
  deferred=0
  while IFS='|' read -r id slug needs note || [ -n "${id:-}" ]; do
    id=$(trim "${id:-}")
    [ -z "$id" ] && continue
    case "$id" in \#*) continue;; esac
    [ -n "$ONE" ] && [ "$id" != "$ONE" ] && continue
    is_done "$id" && continue
    slug=$(trim "${slug:-}")
    # A line with no `|`, or a truncated one, used to start a story on the
    # branch feat/<prefix>-<id>-  with an empty slug. Both fields are mandatory.
    if [ -z "$slug" ]; then
      log "BLOCKED $id — malformed queue line: no slug (a queue line is 'id|slug|needs|note')"
      [ $DRY -eq 0 ] && record_state "$id" BLOCKED-queue "malformed queue line: no slug"
      continue
    fi
    [ -e "$STOP" ] && { log "STOP file present — stopping before $id"; finish; }
    past_deadline && { log "deadline $log_deadline passed — stopping before $id"; finish; }
    if [ $DRY -eq 1 ]; then
      # A dry run previews the whole queue, gated items included, and never
      # calls gh: it annotates the gate instead of evaluating it.
      case "${needs:--}" in -|none|NONE) :;; *) printf '### %s is gated on PR #%s being MERGED in %s\n' "$id" "$(printf '%s' "$needs" | tr -dc '0-9')" "$REPO";; esac
      run_story "$id" "$slug" "${note:-}"
      continue
    fi
    if ! disk_ok; then log "free disk $(free_gb)G below DISK_FLOOR_GB=${DISK_FLOOR_GB}G — stopping before $id"; finish; fi
    needs_satisfied "${needs:--}"; ns=$?
    if [ $ns -eq 2 ]; then
      # Not a skip: a needs value with no PR number in it is a configuration
      # error, and it is recorded and reported, never silently dropped.
      log "BLOCKED $id — needs='$(trim "${needs:-}")' contains no PR number (accepted forms: 115, #115, pr115, PR#115)"
      record_state "$id" BLOCKED-needs "needs='$(trim "${needs:-}")' contains no PR number"
      continue
    fi
    if [ $ns -ne 0 ]; then
      log "SKIP $id (needs PR #$(printf '%s' "$needs" | tr -dc '0-9') not merged yet, pass $pass)"
      deferred=$((deferred + 1))
      # On the LAST pass the deferral is final, so it gets a row of its own and
      # appears in the morning report like every other queue line.
      [ "$pass" -eq 2 ] && record_state "$id" DEFERRED-needs "PR #$(printf '%s' "$needs" | tr -dc '0-9') never merged tonight"
      continue
    fi
    run_story "$id" "$slug" "${note:-}"
  done <"$QUEUE"
  [ "$deferred" -eq 0 ] && break
  [ $DRY -eq 1 ] && break
done
finish
