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
#   --dry-run   print what would happen and exit; launches nothing, takes no
#               lock, writes no state and no report. It combines with --report
#               and --smoke, both of which then also launch nothing.
#   --smoke     one short session that proves the headless setup works, then exit
#   --one <id>  run only that queue id
#   --deadline  the HARD stop of the night. The run stops before the next story
#               once this moment has passed, AND every story's own cap is
#               clamped to the time that is left, so a story can never run past
#               it. Accepts a full timestamp ("2026-09-18 07:30") or a bare
#               H:MM / HH:MM, which means the next occurrence of that time (so
#               7:30 or 07:30 typed at 23:00 is tomorrow morning; both forms
#               behave identically). Compared with `date -d`. Anything else —
#               "7:5", "7:300", "24:00", prose — is REFUSED, and so is a
#               deadline that is still in the past after the roll-forward: a
#               night that silently does nothing is the worst outcome.
#   --report    only (re)write REPORT-<date>.md from the logs; a normal run ends
#               with that same report session by itself.
#
#   kill switch: touch $NIGHT_DIR/STOP   (checked between stories)
#
# STATE IS PER RUN: every queue line ends up in $NIGHT_DIR/state-<date>.txt
# (with $NIGHT_DIR/state.txt kept as a symlink to the newest one), either as
# "<id> <exit code>" for a story that ran, or "<id> <TOKEN> <time> <reason>"
# for one that could not: BLOCKED-queue, BLOCKED-criteria, BLOCKED-needs,
# BLOCKED-needs-unknown, BLOCKED-brief, BLOCKED-deadline, DEFERRED-needs, and
# INTERRUPTED for the one story that was running when the runner was signalled.
# Nothing is ever dropped silently. BLOCKED-* and an exit code are TERMINAL
# (the story is not retried tonight); DEFERRED-needs is not, so pass two can
# still pick the story up. Scoping the file to the run is what lets a story
# parked for context be re-queued the next night (spec section 9) and what lets
# the morning report tell tonight's rows from last night's.
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
#
# EVERY UNANSWERED CHECK FAILS CLOSED. A command that exits non-zero with empty
# output is not an all-clear: if the pgrep scan cannot run, if the lock is
# unreadable while another runner lives, if `df` cannot read the filesystem, or
# if `gh` cannot say whether a PR is merged, the runner refuses or blocks the
# story instead of assuming the best.

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
  echo "run.sh: every field in templates/config.env.tmpl must be set, and every value that can contain a space must be QUOTED: GIT_USER_NAME=\"Jane Smith\"." >&2
  exit 2
fi
case "$PER_STORY_TIMEOUT" in *[!0-9]*) echo "run.sh: PER_STORY_TIMEOUT must be whole seconds, got '$PER_STORY_TIMEOUT'" >&2; exit 2;; esac
[ "$PER_STORY_TIMEOUT" -ge 60 ] || { echo "run.sh: PER_STORY_TIMEOUT must be at least 60 seconds, got '$PER_STORY_TIMEOUT'" >&2; exit 2; }
case "$DISK_FLOOR_GB"     in *[!0-9]*) echo "run.sh: DISK_FLOOR_GB must be a whole number of GB, got '$DISK_FLOOR_GB'" >&2; exit 2;; esac
# Optional, has a default: the bounded CI wait handed to every story session.
# It has a floor because 0 parks every story on its first CI poll.
CI_WAIT_MINUTES=${CI_WAIT_MINUTES:-45}
case "$CI_WAIT_MINUTES" in ""|*[!0-9]*) echo "run.sh: CI_WAIT_MINUTES must be whole minutes, got '$CI_WAIT_MINUTES'" >&2; exit 2;; esac
[ "$CI_WAIT_MINUTES" -ge 1 ] || { echo "run.sh: CI_WAIT_MINUTES must be at least 1 minute (0 parks every story on its first CI poll)" >&2; exit 2; }
# Values that are substituted into the brief with sed, interpolated into the
# story prompt, and — for the git identity — into a single-quoted shell word
# inside it. A newline or a LITERAL $(...)/`...`/${...} in any of them is
# command injection into every story session, so it is refused here rather than
# escaped in three places. (A double-quoted substitution has already run when
# bash sourced the file; only the literal forms survive to this point, and
# those are exactly the ones that would reach a session.)
for v in PROJECT REPO BASE_BRANCH BRANCH_PREFIX REQUIRED_CHECK GIT_USER_NAME GIT_USER_EMAIL MODEL; do
  eval "val=\${$v}"
  # shellcheck disable=SC2016  # the patterns are literal $( ` ${ on purpose
  case "$val" in
    *'`'*|*'$('*|*'${'*) echo "run.sh: $v contains shell substitution syntax ($val) — remove it; the value is interpolated into every story prompt." >&2; exit 2;;
  esac
  case "$val" in
    *[$'\n\r']*) echo "run.sh: $v contains a newline — quote it on ONE line in $CONFIG." >&2; exit 2;;
  esac
done
case "$BRANCH_PREFIX" in *[!A-Za-z0-9._-]*) echo "run.sh: BRANCH_PREFIX must be [A-Za-z0-9._-] (it becomes part of a branch name), got '$BRANCH_PREFIX'" >&2; exit 2;; esac
case "$REPO" in */*) :;; *) echo "run.sh: REPO must be in owner/name form, got '$REPO'" >&2; exit 2;; esac
[ -d "$NIGHT_DIR" ] || { echo "run.sh: NIGHT_DIR does not exist: $NIGHT_DIR" >&2; exit 2; }
# A dry run prints prompts and launches nothing, so it must not need the base
# worktree to exist; every real mode does.
if [ $DRY -eq 0 ]; then
  [ -d "$BASE" ] || { echo "run.sh: BASE worktree does not exist: $BASE" >&2; exit 2; }
  # Without the generated allowlist every session stalls on permission prompts
  # and burns its whole timeout with nothing in the log to say why.
  if [ ! -f "$BASE/.claude/settings.local.json" ] \
     && [ "${PERM_MODE:-auto}" != "bypassPermissions" ] \
     && [ "${NIGHT_ALLOW_NO_SETTINGS:-0}" != "1" ]; then
    echo "run.sh: $BASE/.claude/settings.local.json does not exist." >&2
    echo "run.sh: with --permission-mode ${PERM_MODE:-auto} and no allowlist every story stalls on a permission prompt until its timeout expires." >&2
    echo "run.sh: install it in PHASE E (cp the rendered settings.local.json.tmpl), or set NIGHT_ALLOW_NO_SETTINGS=1 if you really mean to run without it." >&2
    exit 2
  fi
fi

QUEUE=$NIGHT_DIR/queue.txt
BRIEF=$NIGHT_DIR/BRIEF.md
LOGS=$NIGHT_DIR/logs
STOP=$NIGHT_DIR/STOP
LOCK=$NIGHT_DIR/run.lock
CLAUDE_BIN=${CLAUDE_BIN:-claude}
PERM_MODE=${PERM_MODE:-auto}        # same mode as an interactive session, plus $BASE/.claude/settings.local.json
RUN_DATE=$(date +%F)
STATE=$NIGHT_DIR/state-$RUN_DATE.txt   # THIS RUN's rows: <id> <rc|TOKEN> <ISO time> [reason]
EXTRA=(--model "$MODEL")
SETSID=$(command -v setsid 2>/dev/null || true)

mkdir -p "$LOGS" "$NIGHT_DIR/wt"
if [ $DRY -eq 0 ]; then
  touch "$STATE"
  # state.txt stays as the well-known name every doc points at, but it is now a
  # pointer to the CURRENT run's file. An older real state.txt is kept, not
  # destroyed: it is the previous night's evidence.
  if [ -e "$NIGHT_DIR/state.txt" ] && [ ! -L "$NIGHT_DIR/state.txt" ]; then
    mv "$NIGHT_DIR/state.txt" "$NIGHT_DIR/state-before-$RUN_DATE.txt" 2>/dev/null || true
  fi
  ln -sfn "state-$RUN_DATE.txt" "$NIGHT_DIR/state.txt" 2>/dev/null || true
fi
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
# Every live runner's pgid, OUR OWN INCLUDED. Returns non-zero when the SCAN
# ITSELF could not be performed: an erroring or missing pgrep must never be
# read as "no runner is alive" — that is the rc!=0-with-empty-stdout trap that
# has now started a second runner in one worktree three times in this project.
live_runner_pgids(){
  local pids rc p
  pids=$(pgrep -f 'run\.sh' 2>/dev/null); rc=$?
  # pgrep: 0 = matches, 1 = no match, >1 (or 127) = the scan failed.
  [ "$rc" -le 1 ] || return 1
  { for p in $pids; do is_runner_pid "$p" && pgid_of "$p"; done; } | sort -u
}
# The same list in the global LIVE_PGIDS, with the guarantee that the scan
# found THIS process. We are a runner ourselves, so a list without our own pgid
# proves the detector is broken (a stubbed, denied or crippled pgrep) and every
# caller must refuse. It sets a GLOBAL and is never called in a command
# substitution: an `exit` inside `$( )` leaves only the subshell, so a refusal
# written that way does not stop the run at all.
LIVE_PGIDS=""
scan_runners(){   # rc 0 = trustworthy list in LIVE_PGIDS, 1 = scan failed, 2 = we are not in it
  LIVE_PGIDS=$(live_runner_pgids) || { LIVE_PGIDS=""; return 1; }
  printf '%s\n' "$LIVE_PGIDS" | grep -qx "$MY_PGID" || return 2
  return 0
}
# 0 = that process group still exists, or we are not allowed to signal it
# (which is emphatically not "dead"); 1 = it is definitely gone.
pgid_alive(){
  local err rc
  err=$(kill -0 -"$1" 2>&1); rc=$?
  [ "$rc" -eq 0 ] && return 0
  case "$err" in *[Pp]ermitted*|*[Pp]ermission*) return 0;; esac
  return 1
}
MY_PGID=$(pgid_of $$ || echo "$$")
LOCK_HELD=0
lock_owner(){ head -1 "$LOCK" 2>/dev/null | tr -dc '0-9'; }
# Exclusive AND never momentarily empty. The old `( set -C; printf >"$LOCK" )`
# opened the file O_EXCL and only then wrote the pgid, so a rival that read the
# lock in between saw an EMPTY lock and took it over from a live runner. Here
# the pgid is written into a private temp file first and hard-linked into
# place: link() fails when the target exists, so the winner is still decided
# atomically, and the loser never sees a half-written lock.
lock_create(){
  local tmp=$LOCK.$$
  rm -f "$tmp"
  printf '%s\n' "$MY_PGID" >"$tmp" 2>/dev/null || return 1
  if ln "$tmp" "$LOCK" 2>/dev/null; then rm -f "$tmp"; return 0; fi
  rm -f "$tmp"
  # No hard links on this filesystem? Fall back to the atomic-create redirect.
  [ -e "$LOCK" ] && return 1
  ( set -C; printf '%s\n' "$MY_PGID" >"$LOCK" ) 2>/dev/null || return 1
  return 0
}
# shellcheck disable=SC2317  # invoked from the EXIT/INT/TERM traps
release_lock(){
  [ "$LOCK_HELD" -eq 1 ] || return 0
  LOCK_HELD=0
  rm -f "$LOCK.$$"
  local held; held=$(lock_owner)
  if [ "$held" = "$MY_PGID" ]; then
    rm -f "$LOCK"
  else
    # Never delete a lock that now belongs to somebody else.
    log "run.lock holds pgid ${held:-<empty>}, not mine ($MY_PGID) — leaving it in place"
  fi
  return 0
}
STORY_PID=""        # the running story's wrapper, so a signal can stop it with us
STORY_ID=""         # and which queue line it is, so the kill leaves a state row
# shellcheck disable=SC2317  # invoked from the INT/TERM traps
kill_story(){
  [ -n "$STORY_PID" ] || return 0
  local g c cg
  # The story runs in its OWN session (setsid), so its whole tree can be
  # signalled without the runner signalling itself. Leaving it alive while we
  # release the lock is exactly how two sessions end up in one worktree.
  # Only process groups that are OUR OWN child's are ever signalled.
  g=$(pgid_of "$STORY_PID" 2>/dev/null) || g=""
  if [ -n "$g" ] && [ "$g" != "$MY_PGID" ] && [ "$g" -gt 1 ] 2>/dev/null; then
    kill -TERM -"$g" 2>/dev/null || true
  fi
  for c in $(pgrep -P "$STORY_PID" 2>/dev/null); do
    cg=$(pgid_of "$c" 2>/dev/null) || cg=""
    [ -n "$cg" ] && [ "$cg" != "$MY_PGID" ] && [ "$cg" != "$g" ] && [ "$cg" -gt 1 ] 2>/dev/null \
      && kill -TERM -"$cg" 2>/dev/null
  done
  kill -TERM "$STORY_PID" 2>/dev/null || true
  # The queue line must not vanish just because the runner was signalled.
  if [ -n "$STORY_ID" ]; then
    record_state "$STORY_ID" INTERRUPTED "the runner was signalled and killed this story"
    STORY_ID=""
  fi
  return 0
}
acquire_lock(){
  local held try live others sr
  for try in 1 2 3; do
    if lock_create; then
      LOCK_HELD=1
      # The handler MUST exit. `trap release_lock EXIT INT TERM` released the
      # lock and then RESUMED the queue walk, so a second runner acquired
      # cleanly and both walked the same stories in the same worktree.
      trap 'release_lock' EXIT
      trap 'kill_story; release_lock; exit 130' INT
      trap 'kill_story; release_lock; exit 143' TERM
      log "run.lock taken: pgid $MY_PGID (attempt $try)"
      return 0
    fi
    # Somebody else holds it. Everything from here on fails CLOSED.
    scan_runners; sr=$?
    if [ "$sr" -eq 1 ]; then
      echo "run.sh: the runner scan (pgrep) FAILED, so it is unknown whether another runner is alive for $PROJECT — refusing to start." >&2
      exit 3
    fi
    if [ "$sr" -eq 2 ]; then
      echo "run.sh: runner self-detection FAILED — my own pgid ($MY_PGID) is not in the scan, so the scan cannot be trusted to see anyone else's either. Refusing to start." >&2
      echo "run.sh: check by hand with the argv test in the header of this script ($0 --help)." >&2
      exit 3
    fi
    live=$LIVE_PGIDS
    held=$(lock_owner)
    if [ "$held" = "$MY_PGID" ]; then
      LOCK_HELD=1
      trap 'release_lock' EXIT
      trap 'kill_story; release_lock; exit 130' INT
      trap 'kill_story; release_lock; exit 143' TERM
      log "run.lock already carries my own pgid $MY_PGID — adopting it"
      return 0
    fi
    if [ -n "$held" ]; then
      if printf '%s\n' "$live" | grep -qx "$held"; then
        echo "run.sh: a runner is already alive for $PROJECT (pgid $held, $LOCK) — refusing to start a second one." >&2
        echo "run.sh: check it with the argv test in the header of this script ($0 --help)." >&2
        exit 3
      fi
      if pgid_alive "$held"; then
        echo "run.sh: $LOCK holds pgid $held, whose process group is STILL ALIVE (it just does not look like a run.sh) — refusing to start a second runner on a lock that may be live." >&2
        exit 3
      fi
    else
      # Unreadable or empty lock. This used to take over unconditionally,
      # without ever asking whether a runner was alive.
      others=$(printf '%s\n' "$live" | grep -vx "$MY_PGID" | grep -c '[0-9]') || others=""
      if [ "${others:-1}" -gt 0 ]; then
        echo "run.sh: $LOCK is empty or unreadable AND ${others} other runner(s) are alive ($(printf '%s\n' "$live" | grep -vx "$MY_PGID" | tr '\n' ' ')) — refusing to take over a lock that may belong to a live run." >&2
        exit 3
      fi
    fi
    log "stale run.lock (pgid ${held:-unreadable} is not a live run.sh and its process group is gone) — taking it over"
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
    # A full timestamp, a relative expression or an @epoch: hand it to date -d.
    *' '*|*-*|@[0-9]*|*T[0-9]*)
      DEADLINE_EPOCH=$(date -d "$DEADLINE" +%s 2>/dev/null) || DEADLINE_EPOCH="";;
    # Anything else that merely looks like a time is REFUSED rather than
    # leniently reinterpreted: `date -d` reads "7:5" as 07:05 and "7:3" as
    # 07:03, so a typo would silently become a deadline the owner never meant.
    *)
      echo "run.sh: --deadline '$DEADLINE' is not a bare time (use H:MM or HH:MM, e.g. 7:30 or 07:30) and not a full timestamp (e.g. '2026-09-18 07:30')." >&2
      exit 2;;
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

# A df that cannot read the filesystem is NOT an all-clear. The build cache has
# filled this VM's root twice; the spec calls this check "not decorative".
free_gb(){
  local out
  out=$(df -BG --output=avail "$BASE" 2>/dev/null) || return 1
  out=$(printf '%s\n' "$out" | tail -1 | tr -dc '0-9')
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}
disk_ok(){
  local g
  g=$(free_gb) || { log "disk check FAILED: df could not read $BASE — treating it as NOT enough free disk"; return 1; }
  [ "$g" -ge "$DISK_FLOOR_GB" ]
}
free_gb_or_unknown(){ free_gb || printf 'unknown'; }

# sed replacement text: `&` re-inserts the whole match (so "Smith & Co" would
# render as "Smith {{GIT_USER_NAME}} Co") and `|` closes the s||| expression
# (emptying the brief). Escape backslash, ampersand and the delimiter.
sed_repl(){ printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
# A value embedded in a single-quoted shell word: O'Brien -> 'O'\''Brien'.
sq(){ printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

trim(){ local s=$1; s=${s#"${s%%[![:space:]]*}"}; s=${s%"${s##*[![:space:]]}"}; printf '%s' "$s"; }

# state rows: "<id> <rc|TOKEN> <ISO time> [reason]". The id is matched
# LITERALLY (awk $1==id), never as a regex: an id containing `.` or `*` used to
# match unrelated rows and skip a story that never ran.
state_rows(){ awk -v id="$1" '$1==id' "$STATE" 2>/dev/null; }
# TERMINAL = the story ran (numeric exit code) or was blocked for good
# (BLOCKED-*). NON-TERMINAL = DEFERRED-*: the row keeps the line visible in the
# morning report but must NOT stop pass two from retrying it.
is_done(){
  awk -v id="$1" '$1==id && $2 !~ /^DEFERRED-/ {found=1} END{exit !found}' "$STATE" 2>/dev/null
}
last_row(){ state_rows "$1" | tail -1; }

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
GH_ERR=""
# 0 = satisfied, 1 = not merged yet (defer), 2 = unusable value (configuration
# error, the caller must BLOCK the story — never silently skip it), 3 = gh
# could not answer, which is NOT the same as "not merged": an unauthenticated
# gh would otherwise defer every gated story silently.
needs_satisfied(){ # <needs column>: '-' (none) or a PR reference that must be MERGED
  local n=$1 num out rc
  case "$n" in
    ""|-|none|NONE) return 0;;
  esac
  # Accept 115, #115, pr115, PR#115, "pr 115": keep the digits, gate on those.
  num=$(printf '%s' "$n" | tr -dc '0-9')
  [ -n "$num" ] || return 2
  case "$MERGED_PRS" in *" $num "*) return 0;; esac
  out=$(gh pr view "$num" -R "$REPO" --json state --jq .state 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    GH_ERR=$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)
    return 3
  fi
  case "$out" in
    MERGED) MERGED_PRS="$MERGED_PRS$num "; return 0;;
    OPEN|CLOSED) return 1;;
    *) GH_ERR="gh returned an unexpected state: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"; return 3;;
  esac
}

# ------------------------------------------------------- the per-story brief --
# BRIEF.md is rendered by the skill, except for the five values only the runner
# can know or must pin: STORY_DEADLINE_EPOCH, STORY_FINALIZE_EPOCH,
# CI_WAIT_MINUTES, GIT_USER_NAME, GIT_USER_EMAIL. Each story gets its own copy
# with those substituted as LITERALS — the brief compares `date +%s` with a
# number, because shell state does not survive between the session's Bash calls
# and a `$FINALIZE` variable would be unset every single time.
# $NIGHT_DIR/BRIEF-<id>.md is THE authoritative brief and the reviewer's
# criteria source, so it is made read-only (0444) the moment it is rendered:
# the party being graded must not be able to edit what it is graded against.
BRIEF_PATH=""   # set by render_brief on success
RENDER_ERR=""   # set by render_brief on failure
render_brief(){ # id deadline_epoch finalize_epoch; rc != 0 means DO NOT RUN the story
  local id=$1 epoch=$2 finalize=$3 left
  local out=$NIGHT_DIR/BRIEF-$id.md
  BRIEF_PATH=""; RENDER_ERR=""
  if [ ! -f "$BRIEF" ]; then RENDER_ERR="the rendered brief $BRIEF does not exist"; return 1; fi
  # It was left 0444 on purpose, so unlink it — do not try to truncate it.
  rm -f "$out" 2>/dev/null
  if ! sed -e "s|{{STORY_DEADLINE_EPOCH}}|$(sed_repl "$epoch")|g" \
           -e "s|{{STORY_FINALIZE_EPOCH}}|$(sed_repl "$finalize")|g" \
           -e "s|{{CI_WAIT_MINUTES}}|$(sed_repl "$CI_WAIT_MINUTES")|g" \
           -e "s|{{GIT_USER_NAME}}|$(sed_repl "$GIT_USER_NAME")|g" \
           -e "s|{{GIT_USER_EMAIL}}|$(sed_repl "$GIT_USER_EMAIL")|g" \
           "$BRIEF" >"$out" 2>/dev/null; then
    RENDER_ERR="could not render $out from $BRIEF"
    return 1
  fi
  # An unrendered placeholder is FATAL for this story: shipping a brief that
  # still says {{REPO}} or {{STORY_DEADLINE_EPOCH}} sends the session into the
  # night with no repo and no clock. Digits count — {{PR_2}} is a placeholder.
  left=$(grep -o '{{[A-Za-z0-9_]*}}' "$out" 2>/dev/null | sort -u | tr '\n' ' ')
  if [ -n "$left" ]; then
    RENDER_ERR="$out still contains unrendered placeholder(s): ${left% }"
    return 1
  fi
  chmod 0444 "$out" 2>/dev/null || log "WARNING $id: could not chmod 0444 $out — the brief is writable by the session being graded"
  BRIEF_PATH=$out
  return 0
}

# ------------------------------------------------------------ story prompt ---
prompt_for(){ # id slug note brief_path deadline_epoch finalize_epoch budget_seconds
  local gname gmail
  gname=$(sq "$GIT_USER_NAME"); gmail=$(sq "$GIT_USER_EMAIL")
  cat <<P
Invoke the bajzi:autopilot skill first (scope: $PROJECT story $1 only), then read $4 in full and obey it.
Your hard wall clock cap is $7 seconds: the runner's \`timeout\` kills this session at unix epoch $5 ($(date -d "@$5" '+%F %T %Z')), and SIGKILLs it 60 seconds later. At unix epoch $6 ($(date -d "@$6" '+%F %T %Z')) STOP taking new work and finalize — commit what is green, push, open or update the PR, write the handoff, emit the RESULT line. Compare \`date +%s\` with those two numbers, not a feeling, whenever the brief asks how much time is left. Wait at most $CI_WAIT_MINUTES minutes for CI in total. Commit as $GIT_USER_NAME <$GIT_USER_EMAIL> — a fresh worktree may have no git identity, so pin it with \`git -c user.name=$gname -c user.email=$gmail commit ...\`.
You are a HEADLESS per-story session started by the shared night runner; there is no orchestrator, so you are BOTH the story agent (BRIEF section 3) and the merge gate (BRIEF section 5) for story $1 and nothing else. You are NOT your own reviewer: BRIEF section 4 is the review-and-fix loop and it MUST be run by fresh, independent sub-agents; a verdict you write about your own diff is not a review and never satisfies the gate.
$4 is the authoritative brief and the reviewer's criteria source. It is read-only (0444) — never modify it, never chmod it, never render your own copy.
Project: $PROJECT (repo $REPO, base branch $BASE_BRANCH). Required CI check: $REQUIRED_CHECK — only a pull_request-event run of it counts.
Story: $1 — $3
Branch: feat/$BRANCH_PREFIX-$1-$2 in worktree $NIGHT_DIR/wt/$1. Fetch first, then take exactly one case: the path already exists -> continue in it, never recreate; the path is missing but the branch exists locally or on the remote -> git worktree add $NIGHT_DIR/wt/$1 feat/$BRANCH_PREFIX-$1-$2; neither exists -> git worktree add $NIGHT_DIR/wt/$1 -b feat/$BRANCH_PREFIX-$1-$2 origin/$BASE_BRANCH. Append the tree to $NIGHT_DIR/worktrees.tsv as "$1<TAB>path<TAB>branch<TAB>ISO time". Never create a worktree in a deployed tree and never use bare git stash.
Do the story with sub-agents for every heavy step (explore, implement with TDD, run tests, review) so your own context stays small; never read a file over 300 lines yourself.
End the story with the review-and-fix loop: a FRESH, INDEPENDENT Opus 5 sub-agent reviews the diff against origin/$BASE_BRANCH (never your summary of it) and returns VERDICT pass|fail with BLOCKING / NON-BLOCKING findings and an EVIDENCE line; a different sub-agent fixes blocking findings; repeat with a new reviewer, at most 3 rounds. Zero blocking findings = review-green. Still blocking after round 3, or the same finding twice with no change in the diff -> PARK with reason review. Never reach green by deleting or skipping a test, loosening an assertion or lowering a threshold.
When the PR is open, apply the merge gate exactly as written (pull_request-event $REQUIRED_CHECK only, one PR, merge origin/$BASE_BRANCH into the branch first, squash-merge only when the story is BOTH review-green and CI-green; otherwise leave the PR open and PARK it with a reason).
Watch your own context: at roughly half of it stop taking new scope, at roughly 70% finalize — commit what is green, push, open or update the PR, write the handoff and park with reason context.
Then, in $BASE: append a section for $1 to runtime/AUTOPILOT-REPORT.md (PR number, merged or open, tests run and counts, BACKLOG row change, decisions, PARKED/BLOCKED with reasons, what the owner should review), write YOUR OWN per-story handoff at runtime/handoff/night-$1.md (<= 40 lines) and NEVER touch another story's handoff or a shared runtime/handoff/night.md — every other story of tonight is writing its own, run \`brain note decision: ...\` for each non-trivial decision, and finish with ONE line in exactly this grammar:
RESULT $1 <merged|open|parked|blocked> PR#<number or -> reason=<review|timeout|context|ci|forbidden|tests|->
Use reason=- only when the story is merged with nothing to flag; forbidden = a forbidden-zone rule stopped you, tests = a test failure you could not fix, ci = CI was red or never went green, context = you hit your context floor, timeout = you ran out of wall clock, review = the review loop never went green.
Never ask questions; the owner is asleep. Write everything in English. Exit when done.
P
}

run_story(){ # id slug note
  local id=$1 slug=$2 note=$3 rc prompt now budget remain epoch finalize
  # The per-story clock is CLAMPED to the --deadline: --deadline is the hard
  # stop of the night, so a story may never be given a cap that runs past it.
  now=$(date +%s)
  budget=$PER_STORY_TIMEOUT
  if [ -n "$DEADLINE_EPOCH" ]; then
    remain=$(( DEADLINE_EPOCH - now ))
    [ "$remain" -lt "$budget" ] && budget=$remain
  fi
  if [ "$budget" -le 0 ]; then
    log "BLOCKED $id — no time left before the hard deadline $log_deadline; not starting the story"
    [ $DRY -eq 0 ] && record_state "$id" BLOCKED-deadline "no time left before the hard deadline $log_deadline"
    return 1
  fi
  # The absolute moments the session must compare `date +%s` against: when
  # `timeout` kills it, and when it must start finalizing (85% of the budget).
  epoch=$(( now + budget ))
  finalize=$(( now + budget * 85 / 100 ))
  if [ $DRY -eq 1 ]; then
    prompt=$(prompt_for "$id" "$slug" "$note" "$BRIEF" "$epoch" "$finalize" "$budget")
    printf '=== %s (dry-run, budget %ss) ===\n%s\n\n' "$id" "$budget" "$prompt"; return 0
  fi
  if ! render_brief "$id" "$epoch" "$finalize"; then
    log "BLOCKED $id — $RENDER_ERR"
    record_state "$id" BLOCKED-brief "$RENDER_ERR"
    return 1
  fi
  prompt=$(prompt_for "$id" "$slug" "$note" "$BRIEF_PATH" "$epoch" "$finalize" "$budget")
  log "START $id (budget ${budget}s, killed at epoch $epoch = $(date -d "@$epoch" '+%F %T'), finalize at $finalize, brief $BRIEF_PATH)"
  # -k 60: plain `timeout` sends only SIGTERM, and a session that ignores it
  # runs forever — the cap, and with it the deadline, would mean nothing.
  # setsid puts the story in its own session so a signal to the runner can stop
  # the whole story tree without the runner signalling itself.
  # shellcheck disable=SC2086  # $SETSID is a path or deliberately empty
  ( cd "$BASE" && env -u CLAUDECODE \
      STORY_DEADLINE_EPOCH="$epoch" STORY_FINALIZE_EPOCH="$finalize" CI_WAIT_MINUTES="$CI_WAIT_MINUTES" \
      GIT_USER_NAME="$GIT_USER_NAME" GIT_USER_EMAIL="$GIT_USER_EMAIL" \
      GIT_AUTHOR_NAME="$GIT_USER_NAME" GIT_AUTHOR_EMAIL="$GIT_USER_EMAIL" \
      GIT_COMMITTER_NAME="$GIT_USER_NAME" GIT_COMMITTER_EMAIL="$GIT_USER_EMAIL" \
      $SETSID timeout -k 60 "$budget" "$CLAUDE_BIN" -p "$prompt" \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/$id.log" 2>&1 &
  STORY_PID=$!
  STORY_ID=$id
  # Waited for in the background, not run in the foreground, so a SIGTERM to
  # the runner is handled NOW: bash defers a trap until a foreground child has
  # finished, and "handled in three hours" is not handled.
  wait "$STORY_PID"; rc=$?
  STORY_PID=""; STORY_ID=""
  record_state "$id" "$rc"
  log "END $id rc=$rc $(grep -o 'RESULT .*' "$LOGS/$id.log" | tail -1)"
  return $rc
}

# ------------------------------------------------------------- the report ----
write_report(){ # one more fresh session that consolidates the night into REPORT-<date>.md
  local out=$NIGHT_DIR/REPORT-$RUN_DATE.md rc
  log "REPORT start -> $out"
  ( cd "$BASE" && env -u CLAUDECODE timeout -k 60 1800 "$CLAUDE_BIN" -p "Write the night report for the $PROJECT overnight run of $RUN_DATE. Read these with Bash, change nothing else: $STATE; $LOGS/runner.log; the RESULT lines from grep -h 'RESULT ' $LOGS/*.log; $BASE/runtime/AUTOPILOT-REPORT.md; $BASE/runtime/handoff/night-*.md; $BASE/runtime/DECISIONS.md if present; gh pr list -R $REPO --state all --limit 20 --json number,title,state,mergedAt,headRefName; and brain next $PROJECT. Write $out in English with: $STATE holds THIS run's rows only, one or more per queue line, as '<id> <rc|TOKEN> <ISO time> [reason]'. A numeric second field is a story that ran and its exit code. Every other second field is a runner-side outcome with the reason in the rest of the line: BLOCKED-queue (malformed queue line), BLOCKED-criteria (the queue line carried no acceptance criteria), BLOCKED-needs (the needs column held no PR number), BLOCKED-needs-unknown (gh could not say whether the dependency PR is merged), BLOCKED-brief (the per-story brief could not be rendered, so the story was never launched), BLOCKED-deadline (no time left before the hard deadline), DEFERRED-needs (the dependency PR was not merged in time) and INTERRUPTED (the runner was signalled and killed that story mid-flight — say so, and say the story must be re-queued). When an id has several rows the LAST one is its outcome and the earlier ones are its history. Every id in $STATE is a queue line that MUST appear in the table and in section 4, never be omitted. 1) a one-paragraph summary (stories attempted, merged, open, parked, blocked, plus blocked-before-start); 2) one table row per story: id, result, PR, merged or open, review verdict and rounds, tests run; 3) decisions taken on the owner's behalf; 4) PARKED and BLOCKED items with reasons, naming which floor was hit (review, timeout, context, ci, forbidden or tests); 5) any story reported merged or open with reason=review, flagged as a contradiction; 6) LET'S REVIEW THIS TOGETHER in priority order; 7) worktrees under $NIGHT_DIR/wt that are dirty, unpushed or parked and must be kept; 8) what the Brain recommends next. Then run: update-monitor note \"$PROJECT overnight run $RUN_DATE: <one line with PR numbers>\" and brain note night run $RUN_DATE: <one line>. Finish with the line REPORT WRITTEN $out" \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/report.log" 2>&1
  rc=$?
  log "REPORT rc=$rc $(grep -o 'REPORT WRITTEN .*' "$LOGS/report.log" | tail -1)"
}

finish(){ log "RUN end — state ($STATE):"; tee -a "$LOGS/runner.log" <"$STATE"; [ $DRY -eq 1 ] || write_report; exit 0; }

# ----------------------------------------------------------------- modes -----
if [ $REPORT_ONLY -eq 1 ]; then
  # --dry-run means "launches nothing, takes no lock" in EVERY mode.
  if [ $DRY -eq 1 ]; then
    echo "=== --dry-run --report: would take $LOCK, then run one report session in $BASE reading $STATE and write $NIGHT_DIR/REPORT-$RUN_DATE.md. Nothing was launched, no lock was taken."
    exit 0
  fi
  acquire_lock; write_report; exit 0
fi
if [ $SMOKE -eq 1 ]; then
  if [ $DRY -eq 1 ]; then
    echo "=== --dry-run --smoke: would take $LOCK, then run one 300s session in $BASE (model $MODEL, mode $PERM_MODE). Nothing was launched, no lock was taken."
    exit 0
  fi
  acquire_lock
  log "SMOKE start (project=$PROJECT base=$BASE mode=$PERM_MODE model=$MODEL)"
  ( cd "$BASE" && env -u CLAUDECODE timeout -k 60 300 "$CLAUDE_BIN" -p "Run 'brain here' via Bash and then reply with exactly: SMOKE OK <the branch name brain here printed>. Change nothing." \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/smoke.log" 2>&1
  rc=$?; log "SMOKE rc=$rc last line: $(tail -1 "$LOGS/smoke.log")"; exit $rc
fi

[ -f "$QUEUE" ] || { echo "run.sh: queue file not found: $QUEUE" >&2; exit 2; }
# Without the brief there are no worktree rules, no review loop and no merge
# gate — the whole night would run against a nonexistent path and exit 0.
[ -f "$BRIEF" ] || { echo "run.sh: the rendered brief was not found: $BRIEF" >&2; echo "run.sh: PHASE C of the skill renders it; without it no story has worktree rules, a review loop or a merge gate. Refusing to start." >&2; exit 2; }
if [ $DRY -eq 0 ]; then
  acquire_lock
  disk_ok || { log "REFUSING to start: free disk $(free_gb_or_unknown)G is below DISK_FLOOR_GB=${DISK_FLOOR_GB}G (or could not be read)"; exit 4; }
fi

# ------------------------------------------------------------- the queue -----
# Two passes. Pass one runs everything whose `needs` is already satisfied and
# records a state row for every story it starts. Pass two therefore picks up
# ONLY the items pass one never started because their `needs` PR was not merged
# yet — is_done skips anything that already ran or was blocked for good, so a
# story that ran and FAILED is never retried the same night; it is reported and
# re-queued by the next /bajzi:night-run. A DEFERRED row does not count as done.
log "RUN start (project=$PROJECT dry=$DRY one=${ONE:-all} deadline=$log_deadline model=$MODEL ci_wait=${CI_WAIT_MINUTES}m state=$STATE)"
one_matched=0
for pass in 1 2; do
  deferred=0
  while IFS='|' read -r id slug needs note || [ -n "${id:-}" ]; do
    id=$(trim "${id:-}")
    [ -z "$id" ] && continue
    case "$id" in \#*) continue;; esac
    [ -n "$ONE" ] && [ "$id" != "$ONE" ] && continue
    one_matched=1
    # The id is interpolated unquoted into worktree paths, branch names and log
    # file names by the brief and by this script, so its charset is checked.
    case "$id" in
      *[!A-Za-z0-9._-]*|-*|.*)
        log "BLOCKED $id — id must be [A-Za-z0-9._-] and may not start with '-' or '.' (it becomes a path, a branch name and a log file name)"
        [ $DRY -eq 0 ] && record_state "$id" BLOCKED-queue "id charset"
        continue;;
    esac
    # A dry run previews the WHOLE queue: it never reads or writes state.
    if [ $DRY -eq 0 ] && is_done "$id"; then
      # Never a silent `continue`: a skip with no log line made an owner's
      # `--one S1` re-run look like a successful no-op.
      log "SKIP $id — already recorded in this run ($STATE): $(last_row "$id"). Re-run it in a new night, or delete its row."
      continue
    fi
    slug=$(trim "${slug:-}")
    needs=$(trim "${needs:-}")
    note=$(trim "${note:-}")
    # A line with no `|`, or a truncated one, used to start a story on the
    # branch feat/<prefix>-<id>-  with an empty slug. Both fields are mandatory.
    if [ -z "$slug" ]; then
      log "BLOCKED $id — malformed queue line: no slug (a queue line is 'id|slug|needs|note')"
      [ $DRY -eq 0 ] && record_state "$id" BLOCKED-queue "malformed queue line: no slug"
      continue
    fi
    case "$slug" in
      *[!A-Za-z0-9._-]*)
        log "BLOCKED $id — slug '$slug' must be [A-Za-z0-9._-]: it becomes the branch feat/$BRANCH_PREFIX-$id-$slug, and a space or a slash there fails inside the story session, hours later"
        [ $DRY -eq 0 ] && record_state "$id" BLOCKED-queue "slug '$slug' is not a valid branch name fragment"
        continue;;
    esac
    # Acceptance criteria must be REAL. An empty or '-' note gives the reviewer
    # nothing to grade against, and it returns a genuine-looking pass.
    case "$note" in
      ""|-|none|NONE|n/a|N/A|TBD|tbd)
        log "BLOCKED $id — the queue line carries no acceptance criteria (4th column is '${note:-<empty>}'). '-' is the 'none' value of the NEEDS column only; a story with nothing to grade against is never launched."
        [ $DRY -eq 0 ] && record_state "$id" BLOCKED-criteria "no acceptance criteria in the queue line (4th column '${note:-<empty>}')"
        continue;;
    esac
    [ -e "$STOP" ] && { log "STOP file present — stopping before $id"; finish; }
    past_deadline && { log "deadline $log_deadline passed — stopping before $id"; finish; }
    if [ $DRY -eq 1 ]; then
      # A dry run previews the whole queue, gated items included, and never
      # calls gh: it annotates the gate instead of evaluating it.
      case "$needs" in ""|-|none|NONE) :;; *) printf '### %s is gated on PR #%s being MERGED in %s\n' "$id" "$(printf '%s' "$needs" | tr -dc '0-9')" "$REPO";; esac
      run_story "$id" "$slug" "$note"
      continue
    fi
    if ! disk_ok; then log "free disk $(free_gb_or_unknown)G below DISK_FLOOR_GB=${DISK_FLOOR_GB}G — stopping before $id"; finish; fi
    needs_satisfied "$needs"; ns=$?
    if [ $ns -eq 2 ]; then
      # Not a skip: a needs value with no PR number in it is a configuration
      # error, and it is recorded and reported, never silently dropped.
      log "BLOCKED $id — needs='$needs' contains no PR number (accepted forms: 115, #115, pr115, PR#115, or '-' for no dependency)"
      record_state "$id" BLOCKED-needs "needs='$needs' contains no PR number"
      continue
    fi
    if [ $ns -eq 3 ]; then
      # gh could not answer. That is NOT "not merged": an unauthenticated gh
      # would otherwise defer every gated story and the night would do nothing.
      log "BLOCKED $id — could not read PR #$(printf '%s' "$needs" | tr -dc '0-9') in $REPO: $GH_ERR"
      record_state "$id" BLOCKED-needs-unknown "gh could not read PR #$(printf '%s' "$needs" | tr -dc '0-9'): $GH_ERR"
      continue
    fi
    if [ $ns -ne 0 ]; then
      log "SKIP $id (needs PR #$(printf '%s' "$needs" | tr -dc '0-9') not merged yet, pass $pass)"
      deferred=$((deferred + 1))
      # A DEFERRED row on EVERY pass: the queue line stays visible in the
      # report even if the run dies between the passes, and because the row is
      # non-terminal it does not stop pass two from picking the story up.
      record_state "$id" DEFERRED-needs "pass $pass: PR #$(printf '%s' "$needs" | tr -dc '0-9') not merged yet"
      continue
    fi
    run_story "$id" "$slug" "$note"
  done <"$QUEUE"
  [ "$deferred" -eq 0 ] && break
  [ $DRY -eq 1 ] && break
done
if [ -n "$ONE" ] && [ "$one_matched" -eq 0 ]; then
  log "WARNING: --one $ONE matched no line in $QUEUE — nothing ran"
fi
finish
