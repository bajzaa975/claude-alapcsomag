#!/usr/bin/env bash
# THE night runner — shared by every project, never edited per project.
# One fresh headless `claude -p` session per queue line; all project facts come
# from a config.env (see templates/config.env.tmpl).
#
# Usage:
#   run.sh --config <path/to/config.env> [--dry-run] [--smoke] [--one <id>]
#          [--deadline "<HH:MM|YYYY-MM-DD HH:MM>"] [--date YYYY-MM-DD]
#          [--report]
#   (--config may be replaced by the NIGHT_CONFIG environment variable.)
#
#   --dry-run   print what would happen and exit; launches nothing, takes no
#               lock, writes no state and no report. It combines with --report
#               and --smoke, both of which then also launch nothing.
#   --smoke     one short session that proves the headless setup works, then
#               exit. Backgrounded and polled like every other session, so the
#               heartbeat keeps ticking while it runs.
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
#   --date      the NIGHT this run belongs to, YYYY-MM-DD (shape-checked
#               and then handed to `date -d`; anything else is REFUSED).
#               It names the state file and the report and it defaults to
#               today. It exists because RUN_DATE is recomputed at EVERY
#               start: a watcher restart that crosses LOCAL MIDNIGHT would
#               otherwise open an empty state-<new date>.txt and walk the
#               whole queue again, merged stories included. A queue run
#               therefore APPENDS `--date <its own date>` to run.args when
#               the owner gave none, so the watcher's verbatim re-exec
#               stays pinned to the night it is watching.
#   --report    only (re)write REPORT-<date>.md from the logs; a normal run ends
#               with that same report session by itself. Like --smoke it takes
#               the run lock, but it publishes NOTHING to the watcher (see
#               run.args/run.meta/finished below) — it is not the night.
#
#   kill switch: touch $NIGHT_DIR/STOP   (checked between stories, and every
#               5 s during a quota wait, which it aborts)
#
# FILES THE RUN OWNS IN $NIGHT_DIR (the watcher and the morning report read
# them, so their names are a contract):
#   run.flock     the REAL mutual exclusion. `exec 9>>run.flock; flock -n 9`.
#                 The kernel drops the lock when the runner dies, so there is
#                 no stale lock to judge and nothing is ever unlinked. It is
#                 never deleted, and fd 9 is closed in every child so an
#                 orphaned claude session can never keep the run locked.
#   run.lock      OBSERVABILITY ONLY — one line, the live runner's pgid,
#                 written atomically (temp + mv). It decides nothing and the
#                 watcher does not even read it (it probes run.flock); it is
#                 what the owner's PHASE A check prints.
#   run.args      the runner's own argv, one word per line, argv[0] first (the
#                 absolute path of this script): the watcher re-execs the run
#                 with `mapfile -t a <run.args; setsid "${a[@]}"`.
#   run.meta      key=value: pgid, started_epoch, deadline_epoch, run_date,
#                 base, night_dir, skill_dir, config, mode. mode is always
#                 `queue`, because ONLY a queue run publishes run.args and
#                 run.meta at all: --report and --smoke take the lock but
#                 publish nothing and write no `finished`, so a watcher polling
#                 a queue run that has DIED still finds that run's inputs and
#                 restarts it instead of reading mode=report and giving up.
#   heartbeat     touched at least every 60 s while the runner lives — inside
#                 the story wait (<=20 s), inside every quota wait (<=5 s),
#                 inside the report AND smoke session waits (<=20 s), right
#                 after the bounded (<=60 s) `gh` dependency check, and once
#                 per queue line. EVERY model session this script starts is
#                 backgrounded and polled (await_session) for exactly this
#                 reason: nothing here blocks for longer than a minute without
#                 beating. A heartbeat older than that means the runner is
#                 wedged; the watcher calls it STALLED after three missed
#                 beats (180 s).
#   story/<id>.sid  the SESSION id of that story's `claude`. It survives the
#                 story, because it is how a later runner and the watcher tell
#                 an orphaned session from a finished one.
#   quota-until   epoch (reset + QUOTA_MARGIN_SEC): the EXACT moment a session
#                 may be launched again. Every launch site checks it first, and
#                 the watcher compares it with `now` and adds NOTHING — the
#                 margin is applied here, once. The announced reset is
#                 minute-truncated, so one that is already up to 15 minutes
#                 past is the SAME reset and counts as now; further back than
#                 that it is tomorrow's. No single wait may exceed
#                 QUOTA_MAX_WAIT_SEC (6 h by default) — beyond it the run
#                 leaves the rows DEFERRED-quota, reports and finishes instead
#                 of holding run.flock for a day.
#   finished      epoch, written as the LAST act of a non-dry QUEUE run, after
#                 the report. A runner that no longer holds run.flock AND left
#                 no `finished` behind is what makes the watcher restart the
#                 run; a LIVE runner with a stale heartbeat is only ever
#                 STALLED. It is night-scoped, so the queue run DELETES it (and
#                 $NIGHT_DIR/watch.restarts, the watcher's crash hint for its
#                 in-memory restart budget) when it takes the night:
#                 yesterday's copies would tell tonight's watcher that this
#                 night had already ended and that its budget was spent. $NIGHT_DIR/STOP is never removed by the runner — it is
#                 the owner's kill switch and a STOP placed before the run must
#                 still stop the night.
#
# STATE IS PER RUN: every queue line ends up in $NIGHT_DIR/state-<date>.txt
# (with $NIGHT_DIR/state.txt kept as a symlink to the newest one), either as
# "<id> <exit code>" for a story that ran, or "<id> <TOKEN> <time> <reason>"
# for one that could not: BLOCKED-queue, BLOCKED-criteria, BLOCKED-needs,
# BLOCKED-needs-unknown, BLOCKED-brief, BLOCKED-deadline, DEFERRED-needs,
# INTERRUPTED for the one story that was running when the runner was signalled,
# DEFERRED-alive with reason `sid=<sid>` for a story whose PREVIOUS session was
# still alive (so it was not started a second time), and DEFERRED-quota /
# DEFERRED-quota-weekly with reason `resets=<ISO>` for a session the model's
# usage limit cut short.
# Nothing is ever dropped silently — not even a queue line the run never
# reached: the deterministic report lists EVERY id in the queue, and one with
# no state row at all is listed as `not reached`.
# BLOCKED-* and an exit code are TERMINAL
# (the story is not retried tonight); every DEFERRED-* token is not, so a later
# pass can still pick the story up — that is what makes a quota wait work. Scoping the file to the run is what lets a story
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
# $NIGHT_DIR/run.lock carries the live runner's pgid as a second, cheaper check
# — but it is only a REPORT of who holds $NIGHT_DIR/run.flock, never the lock
# itself, and it is never deleted by anyone but its own owner.
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
DRY=0; SMOKE=0; ONE=""; DEADLINE=""; REPORT_ONLY=0; RUN_DATE_ARG=""
# The runner's own argv, kept verbatim for $NIGHT_DIR/run.args so the watcher
# can re-exec exactly this run. argv[0] is resolved to an absolute path.
SELF=$0; case "$SELF" in /*) :;; *) SELF=$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0");; esac
ORIG_ARGV=("$SELF" ${1+"$@"})
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
    --date)     [ $# -ge 2 ] || { echo "run.sh: --date needs a YYYY-MM-DD date" >&2; exit 2; }; RUN_DATE_ARG=$2; shift;;
    --report)   REPORT_ONLY=1;;
    -h|--help)  usage; exit 0;;
    *) echo "run.sh: unknown argument $1" >&2; usage >&2; exit 2;;
  esac
  shift
done

# --date is validated before anything else this run does: a malformed night
# date would silently become a fresh, EMPTY state file and re-run the queue.
if [ -n "$RUN_DATE_ARG" ]; then
  case "$RUN_DATE_ARG" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) :;;
    *) echo "run.sh: --date '$RUN_DATE_ARG' is not a YYYY-MM-DD date" >&2; exit 2;;
  esac
  [ "$(date -d "$RUN_DATE_ARG" +%F 2>/dev/null)" = "$RUN_DATE_ARG" ] ||
    { echo "run.sh: --date '$RUN_DATE_ARG' is not a date date -d understands" >&2; exit 2; }
fi

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
# Optional, all with defaults: the watchdog and the usage-limit (quota) policy.
# They are DEFAULTED, never required, so an older config.env still starts.
: "${WATCH_INTERVAL:=900}"            # seconds between watcher polls; 0 = no watcher
: "${WATCH_MAX_RESTARTS:=2}"          # how many times the watcher may restart the run
: "${WATCH_NOTIFY_CMD:=}"             # optional command, gets ONE message argument
: "${QUOTA_MARGIN_SEC:=180}"          # added to the announced reset before retrying
: "${QUOTA_MAX_WAITS:=3}"             # bounded: a run never waits more times than this
: "${QUOTA_FALLBACK_WAIT_SEC:=1800}"  # used when the reset time cannot be parsed
: "${QUOTA_MAX_WAIT_SEC:=21600}"      # 6 h: no SINGLE quota wait may be longer
for v in WATCH_INTERVAL WATCH_MAX_RESTARTS QUOTA_MARGIN_SEC QUOTA_MAX_WAITS QUOTA_FALLBACK_WAIT_SEC QUOTA_MAX_WAIT_SEC; do
  eval "val=\${$v}"
  case "$val" in ""|*[!0-9]*) echo "run.sh: $v must be a whole number, got '$val'" >&2; exit 2;; esac
done
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
LOCK=$NIGHT_DIR/run.lock          # observability only: the live runner's pgid
FLOCK=$NIGHT_DIR/run.flock        # THE lock; fd 9; never unlinked
STORYDIR=$NIGHT_DIR/story         # story/<id>.sid — the per-story session ids
QUOTA_FILE=$NIGHT_DIR/quota-until
HEARTBEAT=$NIGHT_DIR/heartbeat
FINISHED=$NIGHT_DIR/finished
RUN_ARGS=$NIGHT_DIR/run.args
RUN_META=$NIGHT_DIR/run.meta
SKILL_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || SKILL_DIR=""
CLAUDE_BIN=${CLAUDE_BIN:-claude}
PERM_MODE=${PERM_MODE:-auto}        # same mode as an interactive session, plus $BASE/.claude/settings.local.json
RUN_DATE=${RUN_DATE_ARG:-$(date +%F)}
RUN_MODE=queue; [ $REPORT_ONLY -eq 1 ] && RUN_MODE=report; [ $SMOKE -eq 1 ] && RUN_MODE=smoke
STATE=$NIGHT_DIR/state-$RUN_DATE.txt   # THIS RUN's rows: <id> <rc|TOKEN> <ISO time> [reason]
EXTRA=(--model "$MODEL")
SETSID=$(command -v setsid 2>/dev/null || true)
# Not cosmetic and no longer optional: the story is exec'd THROUGH setsid so
# that the backgrounded pid IS the story's session id. Without it there is no
# per-story liveness check, no drain and no orphan detection — so it fails
# closed rather than silently running a story the runner cannot account for.
if [ $DRY -eq 0 ] && [ -z "$SETSID" ]; then
  echo "run.sh: setsid is not installed. Every story must run in its OWN session so the runner can prove it ended; install util-linux (setsid)." >&2
  exit 2
fi

mkdir -p "$LOGS" "$NIGHT_DIR/wt" "$STORYDIR"
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
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGS/runner.log" 9>&-; }

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
MY_PGID=$(pgid_of $$ || echo "$$")
LOCK_HELD=0
lock_owner(){ head -1 "$LOCK" 2>/dev/null | tr -dc '0-9'; }
# run.lock is written atomically or not at all: a rival that reads it must
# never see a half-written or momentarily empty file. It is OBSERVABILITY, not
# the lock — the lock is flock(2) on fd 9 of $FLOCK.
lock_publish(){
  local tmp=$LOCK.$$.tmp
  printf '%s\n' "$MY_PGID" >"$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$LOCK" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  return 0
}
# shellcheck disable=SC2317  # invoked from the EXIT/INT/TERM traps
release_lock(){
  [ "$LOCK_HELD" -eq 1 ] || return 0
  LOCK_HELD=0
  rm -f "$LOCK.$$.tmp" 2>/dev/null
  local held; held=$(lock_owner)
  if [ "$held" = "$MY_PGID" ]; then
    rm -f "$LOCK"
  else
    # Never delete a lock that now belongs to somebody else.
    log "run.lock holds pgid ${held:-<empty>}, not mine ($MY_PGID) — leaving it in place"
  fi
  # $FLOCK itself is NEVER unlinked; closing fd 9 is what releases the lock,
  # and the kernel does exactly this for us if the runner dies instead.
  exec 9>&- 2>/dev/null || true
  return 0
}
# Which config a foreign runner targets, so two DIFFERENT projects' nights can
# run side by side: `--config <path>` in its argv, else NIGHT_CONFIG in its
# environment. Empty = could not tell, and the caller then treats it as OURS
# (fail closed).
runner_config_of(){
  local pid=$1 tok next="" val=""
  while IFS= read -r -d '' tok; do
    if [ -n "$next" ]; then val=$tok; break; fi
    [ "$tok" = "--config" ] && next=1
  done <"/proc/$pid/cmdline" 2>/dev/null
  if [ -z "$val" ]; then
    while IFS= read -r -d '' tok; do
      case "$tok" in NIGHT_CONFIG=*) val=${tok#NIGHT_CONFIG=}; break;; esac
    done <"/proc/$pid/environ" 2>/dev/null
  fi
  [ -n "$val" ] && val=$(readlink -f "$val" 2>/dev/null || printf '%s' "$val")
  printf '%s' "$val"
}
MY_CONFIG=$(readlink -f "$CONFIG" 2>/dev/null || printf '%s' "$CONFIG")
MY_SELF=$(readlink -f "$SELF" 2>/dev/null || printf '%s' "$SELF")
# WHICH run.sh a foreign runner is executing, absolute. A relative argv is
# resolved against its cwd, which is a hint and not a proof — it is only ever
# used to let a DIFFERENT installation of this script (another project's older
# runner, which is the normal case on a shared machine) off the hook.
runner_script_of(){
  local pid=$1 a0="" a1="" cand="" cwd
  { IFS= read -r -d '' a0 || true; IFS= read -r -d '' a1 || true; } <"/proc/$pid/cmdline" 2>/dev/null
  [ "${a1##*/}" = "run.sh" ] && cand=$a1
  [ -z "$cand" ] && [ "${a0##*/}" = "run.sh" ] && cand=$a0
  [ -n "$cand" ] || return 1
  case "$cand" in
    /*) :;;
    *)  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || cwd=""
        [ -n "$cwd" ] && cand=$cwd/$cand;;
  esac
  readlink -f "$cand" 2>/dev/null || printf '%s' "$cand"
}
# Other live runners that could be running THIS night, as a count of distinct
# pgids. Scoping matters: this script is shared by every project, so several
# unrelated nights legitimately run at once. A runner is OURS when it names the
# same config; when its config cannot be determined it is still not ours if it
# is a different run.sh FILE; and when nothing can be determined it counts as
# ours, because an unanswered check fails closed.
others_here(){
  local p g c sc out=""
  for p in $(pgrep -f 'run\.sh' 2>/dev/null); do
    is_runner_pid "$p" || continue
    g=$(pgid_of "$p" 2>/dev/null) || continue
    [ "$g" = "$MY_PGID" ] && continue
    c=$(runner_config_of "$p")
    if [ -n "$c" ]; then
      [ "$c" != "$MY_CONFIG" ] && continue
    else
      sc=$(runner_script_of "$p") || sc=""
      [ -n "$sc" ] && [ "$sc" != "$MY_SELF" ] && continue
    fi
    out="$out$g
"
  done
  printf '%s' "$out" | sort -u | grep -c '[0-9]' || true
}
# THE lock. flock(2) on a file that is never unlinked, so there is no stale
# state to judge: the kernel releases it when the runner dies. The old scheme
# read the lock ONCE and then `rm -f` it if it looked stale, and two runners
# that both judged the same dead pgid both reached that rm — the second one
# deleted the WINNER's fresh, live lock (measured 9 times in 40).
acquire_lock(){
  local sr held waited others
  if ! command -v flock >/dev/null 2>&1; then
    echo "run.sh: flock is not installed, so the run lock cannot be taken." >&2
    echo "run.sh: this is FATAL on purpose — the old check-then-act lock let two runners into one worktree, and there is no safe fallback. Install util-linux (flock)." >&2
    exit 2
  fi
  if ! exec 9>>"$FLOCK"; then
    echo "run.sh: cannot open the run lock file $FLOCK for writing — refusing to start." >&2
    exit 2
  fi
  if ! flock -n 9; then
    held=$(lock_owner)
    echo "run.sh: a runner already holds $FLOCK for $PROJECT${held:+ (pgid $held, per $LOCK)} — refusing to start a second one." >&2
    echo "run.sh: check it with the argv test in the header of this script ($0 --help)." >&2
    exit 3
  fi
  LOCK_HELD=1
  # The handler MUST exit. `trap release_lock EXIT INT TERM` released the lock
  # and then RESUMED the queue walk, so a second runner acquired cleanly and
  # both walked the same stories in the same worktree.
  trap 'release_lock' EXIT
  trap 'kill_story; release_lock; exit 130' INT
  trap 'kill_story; release_lock; exit 143' TERM
  lock_publish || log "WARNING: could not write $LOCK — the run IS locked ($FLOCK), but the owner's pgid check will not see it"
  # Re-validate, now that we hold the lock. Everything here fails CLOSED.
  held=$(lock_owner)
  if [ "$held" != "$MY_PGID" ]; then
    echo "run.sh: $LOCK carries pgid ${held:-<empty>}, not mine ($MY_PGID), while I hold $FLOCK — something else is writing the lock file; refusing to start." >&2
    exit 3
  fi
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
  # A rival that lost the flock race is still on its way out, so this is
  # retried briefly rather than judged on one sample; a rival that is really
  # stuck is still there after the window and we refuse.
  waited=0
  while :; do
    others=$(others_here)
    [ "${others:-1}" -eq 0 ] && break
    [ "$waited" -ge 10 ] && {
      echo "run.sh: I hold $FLOCK, but ${others} other run.sh process(es) for this config are still alive after ${waited}s — refusing to run two runners in one worktree." >&2
      echo "run.sh: check them with the argv test in the header of this script ($0 --help)." >&2
      exit 3
    }
    # `9>&-`: fd 9 IS the run lock, and flock(2) lives on the open file
    # description, so this `sleep` would hold the project locked for as long as
    # it lived if the runner were SIGKILLed while it waited. (`nap` is the same
    # rule, one function further down.)
    sleep 1 9>&-; waited=$((waited + 1))
  done
  log "run lock taken: $FLOCK held on fd 9, pgid $MY_PGID published to $LOCK"
  return 0
}

# ------------------------------- story sessions, heartbeat, the quota clock ---
# A run that is alive says so at least once a minute; the watcher restarts a
# run whose heartbeat has gone stale and that never wrote `finished`.
# A dry run writes NOTHING — not state, not a report and not a heartbeat.
beat(){ [ $DRY -eq 0 ] || return 0; touch "$HEARTBEAT" 2>/dev/null || true; }
# An INTERRUPTIBLE sleep. A plain `sleep` defers a trap until it returns, and
# "the TERM handler runs in twenty minutes" is not handling a signal; bash
# returns from `wait` the moment a trapped signal arrives.
# `9>&-` is not decoration. fd 9 is the run lock, and flock(2) lives on the
# OPEN FILE DESCRIPTION, not on the process: any child that still holds a copy
# keeps the whole project locked after the runner is SIGKILLed. A `sleep` that
# inherited it did exactly that — the runner was gone and the next runner was
# refused, which is the failure this whole rewrite exists to remove.
nap(){
  local p
  sleep "$1" 9>&- & p=$!
  wait "$p" 2>/dev/null || true
}
# `kill -0` is TRUE for a zombie, so a child that has exited but not been
# reaped would spin a poll loop forever. procfs state (the field right after
# comm) is what actually distinguishes them.
proc_alive(){
  local st
  st=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  st=${st#*") "}
  # shellcheck disable=SC2086
  set -- $st
  [ $# -ge 1 ] || return 1
  [ "$1" != "Z" ]
}
# EVERY model session this script starts — story, report and smoke — is
# BACKGROUNDED and polled through this, never run in the foreground. Two
# reasons, both load-bearing: the heartbeat must keep ticking (the watcher
# calls a runner whose beat is 180 s old STALLED, and --smoke ran a 360 s
# session in the foreground without beating once), and a SIGTERM to the runner
# must be handled NOW — bash defers a trap until the foreground command
# returns, and "handled in three hours" is not handling a signal.
# The interval starts at a second and backs off to twenty: a session that dies
# in four seconds on a usage limit must not cost a whole poll slice, a session
# that runs for hours must not cost a fork a second, and twenty is well inside
# the sixty seconds the heartbeat contract allows.
# `kill -0` is true for a zombie, so liveness is read from procfs; the exit
# code is collected with a real `wait` and IS this function's return value.
await_session(){ # pid
  local p=$1 poll=1
  while proc_alive "$p"; do
    beat; nap "$poll"
    if [ "$poll" -lt 20 ]; then poll=$(( poll * 2 )); [ "$poll" -gt 20 ] && poll=20; fi
  done
  beat
  wait "$p"
}
# The pids that are still in a story's SESSION. `pgrep -s 0` means "my own
# session", so an empty or zero sid is never passed through.
session_members(){
  local sid=$1
  case "$sid" in ""|0|*[!0-9]*) return 1;; esac
  pgrep -s "$sid" 2>/dev/null
}
session_alive(){ [ -n "$(session_members "$1")" ]; }

STORY_PID=""        # the story's session leader, so a signal can stop it with us
STORY_ID=""         # and which queue line it is, so the kill leaves a state row
STORY_SID=""        # == STORY_PID: the story is exec'd through setsid, so the
                    # backgrounded process IS the session leader
REPORT_PID=""       # the narrative report session, also backgrounded so the
                    # runner can keep beating while it runs. It is NOT setsid'd
                    # (it shares the runner's session), so it is signalled by
                    # PID — never with stop_session, which would kill us too.
# Signal every member of a story's own session and say what was left. Only
# sessions THIS runner created are ever signalled.
stop_session(){ # sid label
  local sid=$1 label=$2 p n waited=0
  session_alive "$sid" || return 0
  n=$(session_members "$sid" | wc -l)
  log "$label: session $sid still has $n member(s) — sending TERM"
  for p in $(session_members "$sid"); do kill -TERM "$p" 2>/dev/null || true; done
  while [ "$waited" -lt 20 ]; do
    session_alive "$sid" || { log "$label: session $sid ended after TERM (${waited}s)"; return 0; }
    nap 1; waited=$((waited + 1))
  done
  n=$(session_members "$sid" | wc -l)
  log "$label: session $sid still has $n member(s) 20s after TERM — sending KILL"
  for p in $(session_members "$sid"); do kill -KILL "$p" 2>/dev/null || true; done
  return 0
}
# shellcheck disable=SC2317  # invoked from the INT/TERM traps
kill_story(){
  if [ -n "$REPORT_PID" ]; then
    log "KILL report session (pid $REPORT_PID) — the runner was signalled"
    kill -TERM "$REPORT_PID" 2>/dev/null || true
    REPORT_PID=""
  fi
  [ -n "$STORY_PID" ] || return 0
  # The story runs in its OWN session (setsid), so its whole tree can be
  # signalled without the runner signalling itself. Leaving it alive while we
  # release the lock is exactly how two sessions end up in one worktree. The
  # target is the RECORDED sid, not a pgid guessed from the wrapper.
  stop_session "${STORY_SID:-$STORY_PID}" "KILL ${STORY_ID:-story}"
  kill -TERM "$STORY_PID" 2>/dev/null || true
  # The queue line must not vanish just because the runner was signalled.
  if [ -n "$STORY_ID" ]; then
    record_state "$STORY_ID" INTERRUPTED "the runner was signalled and killed this story"
    STORY_ID=""
  fi
  return 0
}

# ---- the usage limit (quota) ------------------------------------------------
# The message this parses, verbatim, from the 2026-09-18 run:
#   You've hit your session limit · resets 5:50am (UTC)
# It arrives on stdout with exit code 1, within seconds — nothing like a real
# story failure, and recording it as "rc=1, story failed" threw the whole night
# away. It becomes a NON-TERMINAL DEFERRED-quota row plus a wait.
QUOTA_WAITS=0
QUOTA_WEEKLY=0
# The message is minute-truncated and carries no date, so the reset it
# announces is routinely a few seconds BEHIND the clock by the time the runner
# reads it: "resets 11:02am" printed at 11:02:40 and read at 11:03 is the SAME
# reset, not tomorrow's. Inside this grace the reset is treated as NOW; further
# back than it, the time really is tomorrow's.
QUOTA_PAST_GRACE_SEC=900
CLASS_TOKEN=""      # set by classify_result: the state token to record
CLASS_REASON=""     # set by classify_result: the reason column ("" for a plain rc)
QUOTA_RESET_EPOCH="" # set by classify_result when the token is a quota one
classify_result(){ # id rc logfile
  local rc=$2 lf=$3 endlines msg low t zone epoch now d cand tzp
  CLASS_TOKEN=$rc; CLASS_REASON=""; QUOTA_RESET_EPOCH=""
  case "$rc" in 0) return 0;; esac
  # The LAST 40 non-empty lines, not the last 8: the limit message is not
  # always the last thing a session prints — a wrapper, a stack trace or a
  # summary can follow it — and a limit burned as a plain failure throws the
  # story (and, in the queue walk, the whole night) away. Still rc != 0 only:
  # a session that exited 0 is never a quota stop, whatever its log ends with.
  endlines=$(grep -v '^[[:space:]]*$' "$lf" 2>/dev/null | tail -40)
  msg=$(printf '%s\n' "$endlines" | grep -iE 'hit your .*limit' | tail -1)
  [ -n "$msg" ] || return 0
  low=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')
  case "$low" in
    *weekly*) CLASS_TOKEN=DEFERRED-quota-weekly; QUOTA_WEEKLY=1;;
    *)        CLASS_TOKEN=DEFERRED-quota;;
  esac
  # "resets 5:50am (UTC)", "resets 5pm", "resets 11:05pm (Europe/Budapest)",
  # and a bare 24-hour "resets 05:50" as a fallback.
  t=$(printf '%s' "$msg" | sed -n 's/.*[Rr]esets[[:space:]]*\([0-9][0-9]*\(:[0-9][0-9]\)\{0,1\}[[:space:]]*[AaPp][Mm]\).*/\1/p')
  [ -n "$t" ] || t=$(printf '%s' "$msg" | sed -n 's/.*[Rr]esets[[:space:]]*\([0-9][0-9]*:[0-9][0-9]\).*/\1/p')
  zone=$(printf '%s' "$msg" | sed -n 's/.*[Rr]esets[^(]*(\([^)]*\)).*/\1/p')
  epoch=""
  if [ -n "$t" ]; then
    now=$(date +%s)
    # The announced time carries no DATE, and `date -d` resolves a bare time
    # against the current day OF THE ZONE it is told to use. In a zone whose
    # local day has already rolled over relative to the runner's, that day is
    # one too many: "resets 11:56pm (Etc/GMT+12)" announced 25 minutes earlier
    # came out 1414 minutes AHEAD and would have parked the night. So the
    # candidate epoch is computed for yesterday, today AND tomorrow in the
    # announcing zone, and the EARLIEST candidate that is not older than the
    # grace wins: yesterday's for a zone that has rolled over, today's for the
    # ordinary case, tomorrow's for a reset that really is in the past.
    tzp=""; [ -n "$zone" ] && tzp="TZ=\"$zone\" "
    for d in 'yesterday ' '' 'tomorrow '; do
      cand=$(date -d "$tzp$d$t" +%s 2>/dev/null) || continue
      [ -n "$cand" ] || continue
      [ "$cand" -lt $(( now - QUOTA_PAST_GRACE_SEC )) ] && continue
      epoch=$cand; break
    done
    # Inside the grace the announced reset is the SAME reset a truncated minute
    # ago: treat it as NOW, so quota-until becomes now + QUOTA_MARGIN_SEC and
    # the run waits the margin. Rolling EVERY past time a full day forward is
    # what produced "QUOTA-WAIT until <tomorrow> (1442 min)" and held the run
    # lock for a day after a reset announced one minute earlier.
    if [ -n "$epoch" ] && [ "$epoch" -le "$now" ]; then epoch=$now; fi
  fi
  if [ -n "$epoch" ]; then
    CLASS_REASON="resets=$(date -u -d "@$epoch" +%FT%TZ)"
  else
    # Unparseable: say so honestly and fall back to a fixed wait, never to 0.
    epoch=$(( $(date +%s) + QUOTA_FALLBACK_WAIT_SEC ))
    CLASS_REASON="resets=unknown"
  fi
  QUOTA_RESET_EPOCH=$epoch
  return 0
}
quota_until(){ # prints the epoch in $QUOTA_FILE, or nothing
  [ -f "$QUOTA_FILE" ] || return 1
  local e; e=$(tr -dc '0-9' <"$QUOTA_FILE" 2>/dev/null)
  [ -n "$e" ] || return 1
  printf '%s' "$e"
}
quota_arm(){ # reset_epoch — every launch site checks this file before starting a session
  local e=$(( $1 + QUOTA_MARGIN_SEC ))
  printf '%s\n' "$e" >"$QUOTA_FILE" 2>/dev/null || log "WARNING: could not write $QUOTA_FILE"
}
MIN_STORY_BUDGET=60   # the same floor PER_STORY_TIMEOUT has
# rc 0 = the quota window is over (or there never was one), the caller may
# launch; rc 1 = the caller must FINISH the run.
quota_wait(){
  local e now left iso mins
  e=$(quota_until) || return 0
  now=$(date +%s)
  if [ "$e" -le "$now" ]; then rm -f "$QUOTA_FILE"; return 0; fi
  if [ "$QUOTA_WEEKLY" -eq 1 ]; then
    log "QUOTA-WAIT refused — this is a WEEKLY limit (resets $(date -u -d "@$e" +%FT%TZ)); no night can wait that out. Finishing."
    return 1
  fi
  # A SINGLE wait is bounded too, not just their number. A reset that resolves
  # a day out (a mis-parse, a clock skew, or a limit that really does reset
  # tomorrow) would otherwise hold run.flock — the whole project — for that
  # day, with nothing running and no report until it ended.
  left=$(( e - now )); mins=$(( (left + 59) / 60 ))
  if [ "$left" -gt "$QUOTA_MAX_WAIT_SEC" ]; then
    log "QUOTA-WAIT refused — $mins min exceeds QUOTA_MAX_WAIT_SEC=${QUOTA_MAX_WAIT_SEC}s (reset $(date -u -d "@$e" +%FT%TZ)). The DEFERRED-quota rows stand and the next night re-queues them. Finishing."
    return 1
  fi
  QUOTA_WAITS=$((QUOTA_WAITS + 1))
  if [ "$QUOTA_WAITS" -gt "$QUOTA_MAX_WAITS" ]; then
    log "QUOTA-WAIT refused — already waited $QUOTA_MAX_WAITS time(s) this run (QUOTA_MAX_WAITS=$QUOTA_MAX_WAITS). Finishing."
    return 1
  fi
  if [ -n "$DEADLINE_EPOCH" ] && [ $(( e + MIN_STORY_BUDGET )) -gt "$DEADLINE_EPOCH" ]; then
    log "QUOTA-WAIT refused — waiting until $(date -u -d "@$e" +%FT%TZ) would leave less than ${MIN_STORY_BUDGET}s before the hard deadline $log_deadline. The DEFERRED-quota rows stand. Finishing."
    return 1
  fi
  iso=$(date -u -d "@$e" +%FT%TZ); mins=$(( (e - now + 59) / 60 ))
  log "QUOTA-WAIT until $iso ($mins min)"
  while :; do
    now=$(date +%s)
    [ "$now" -ge "$e" ] && break
    if [ -e "$STOP" ]; then
      log "QUOTA-WAIT aborted — the STOP file appeared. $STOP says: $(head -1 "$STOP" 2>/dev/null || echo '<empty>'). Finishing."
      return 1
    fi
    beat
    # STOP is the only way out of a long wait, so it must be seen within
    # SECONDS: the slice is capped at 5 s, not at a minute. Beating once per
    # slice is free and keeps the heartbeat far inside the watcher's 180 s.
    left=$(( e - now )); [ "$left" -gt 5 ] && left=5
    nap "$left"
  done
  rm -f "$QUOTA_FILE"
  beat
  log "QUOTA-WAIT over (until $iso)"
  return 0
}
# EVERY launch site — story and report — goes through this first.
quota_gate(){ # rc 0 = clear to launch, 1 = the caller must finish
  local e
  e=$(quota_until) || return 0
  [ "$e" -le "$(date +%s)" ] && { rm -f "$QUOTA_FILE"; return 0; }
  quota_wait
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
  # BOUNDED: an unreachable API or a `gh` waiting on a credential helper would
  # otherwise block the queue walk indefinitely — with no heartbeat, so the
  # watcher would call a perfectly healthy runner STALLED. A timeout is a gh
  # failure like any other and fails CLOSED (the story is BLOCKED-needs-unknown,
  # never silently treated as "not merged").
  out=$(timeout -k 5 60 gh pr view "$num" -R "$REPO" --json state --jq .state 2>&1); rc=$?
  beat
  if [ "$rc" -ne 0 ]; then
    GH_ERR=$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)
    [ -n "$GH_ERR" ] || GH_ERR="gh exited $rc with no output (timed out after 60s?)"
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

# QUEUE_ACTION is how run_story talks back to the queue walk: its RETURN VALUE
# is the story's exit code and the loop must not read that as an instruction.
#   continue = take the next queue line (the default)
#   wait     = the usage limit stopped this story; wait it out, then carry on
#   stop     = finish the run now (weekly limit, or a wait we may not take)
QUEUE_ACTION="continue"
run_story(){ # id slug note
  local id=$1 slug=$2 note=$3 rc prompt now budget remain epoch finalize prev sidf
  QUEUE_ACTION="continue"
  sidf=$STORYDIR/$id.sid
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
  # A session from an EARLIER runner (or an earlier pass) may still be alive in
  # this story's worktree. Launching a second one there is the accident the
  # whole lock exists to prevent, and until now nothing checked it per story.
  prev=""
  [ -f "$sidf" ] && prev=$(tr -dc '0-9' <"$sidf" 2>/dev/null)
  if [ -n "$prev" ] && session_alive "$prev"; then
    log "SKIP $id — previous session $prev still alive"
    # NEVER a silent skip: nothing is dropped without a row. DEFERRED-alive is
    # non-terminal, so a later pass — or the next night — picks the story up
    # once that session is gone, and the morning report can account for the
    # queue line instead of leaving it out.
    record_state "$id" DEFERRED-alive "sid=$prev"
    return 0
  fi
  # No session may start while the usage limit is still in force.
  if ! quota_gate; then QUEUE_ACTION="stop"; return 0; fi
  prompt=$(prompt_for "$id" "$slug" "$note" "$BRIEF_PATH" "$epoch" "$finalize" "$budget")
  log "START $id (budget ${budget}s, killed at epoch $epoch = $(date -d "@$epoch" '+%F %T'), finalize at $finalize, brief $BRIEF_PATH)"
  # -k 60: plain `timeout` sends only SIGTERM, and a session that ignores it
  # runs forever — the cap, and with it the deadline, would mean nothing.
  # `exec env … setsid …` (not a plain command in a subshell) is what makes $!
  # the story's SESSION LEADER instead of a throwaway wrapper pid: setsid does
  # not fork here, so the pid we record is the sid every later check uses.
  # `exec 9>&-` first: fd 9 is the run lock, and an orphaned claude session
  # that inherited it would keep the whole project locked after we are gone.
  ( exec 9>&-; cd "$BASE" && exec env -u CLAUDECODE \
      STORY_DEADLINE_EPOCH="$epoch" STORY_FINALIZE_EPOCH="$finalize" CI_WAIT_MINUTES="$CI_WAIT_MINUTES" \
      GIT_USER_NAME="$GIT_USER_NAME" GIT_USER_EMAIL="$GIT_USER_EMAIL" \
      GIT_AUTHOR_NAME="$GIT_USER_NAME" GIT_AUTHOR_EMAIL="$GIT_USER_EMAIL" \
      GIT_COMMITTER_NAME="$GIT_USER_NAME" GIT_COMMITTER_EMAIL="$GIT_USER_EMAIL" \
      "$SETSID" timeout -k 60 "$budget" "$CLAUDE_BIN" -p "$prompt" \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/$id.log" 2>&1 &
  STORY_PID=$!
  STORY_SID=$STORY_PID
  STORY_ID=$id
  # Written BEFORE the wait and KEPT afterwards: it is how the watcher and the
  # next runner tell an orphaned session from a finished story.
  printf '%s\n' "$STORY_SID" >"$sidf" 2>/dev/null || log "WARNING $id: could not write $sidf"
  # Polled, not a plain `wait`: see await_session. The heartbeat has to keep
  # ticking for the watcher, and a signal to the runner has to be handled while
  # the story is still running, not hours later.
  await_session "$STORY_PID"; rc=$?
  # The wrapper is gone; the SESSION may not be. A claude that survived its own
  # timeout would otherwise keep working in the worktree the next story uses.
  stop_session "$STORY_SID" "DRAIN $id"
  STORY_PID=""; STORY_ID=""; STORY_SID=""
  classify_result "$id" "$rc" "$LOGS/$id.log"
  # shellcheck disable=SC2086  # an EMPTY reason must not become an empty argument
  record_state "$id" "$CLASS_TOKEN" $CLASS_REASON
  log "END $id rc=$rc token=$CLASS_TOKEN $(grep -o 'RESULT .*' "$LOGS/$id.log" | tail -1)"
  case "$CLASS_TOKEN" in
    DEFERRED-quota-weekly)
      quota_arm "$QUOTA_RESET_EPOCH"
      log "QUOTA $id — WEEKLY limit ($CLASS_REASON). No wait can help tonight; finishing after the report."
      QUEUE_ACTION="stop";;
    DEFERRED-quota)
      quota_arm "$QUOTA_RESET_EPOCH"
      log "QUOTA $id — session limit ($CLASS_REASON); no session may start before $(date -u -d "@$(quota_until)" +%FT%TZ)"
      QUEUE_ACTION="wait";;
  esac
  return $rc
}

# ------------------------------------------------------------- the report ----
# The report is written in TWO layers, and the first one needs no model at
# all. A night that ended because the usage limit was hit is exactly the night
# whose report a model session cannot write, and "no report" is how a night
# becomes invisible. So the facts are written from the state rows first, and
# the narrative is APPENDED afterwards if a session can still run.
# Every id this run's queue offers, in queue order, filtered by --one exactly
# as the walk filters it. It is what lets the report name a story the run never
# reached at all.
queue_ids(){
  local id rest
  [ -f "$QUEUE" ] || return 0
  while IFS='|' read -r id rest || [ -n "${id:-}" ]; do
    id=$(trim "${id:-}")
    [ -z "$id" ] && continue
    case "$id" in \#*) continue;; esac
    [ -n "$ONE" ] && [ "$id" != "$ONE" ] && continue
    printf '%s\n' "$id"
  done <"$QUEUE"
}
report_deterministic(){ # out
  local out=$1 id tok iso reason rid row rcline
  {
    printf '# Night report — %s — %s\n\n' "$PROJECT" "$RUN_DATE"
    # shellcheck disable=SC2016  # the backticks are markdown code spans
    printf '_Written by run.sh from `%s` and the story logs. This part needs no model session, so it exists even when the night ended on a usage limit or a crash. A `## Narrative` section below is appended by a Claude session when one can still run._\n\n' "$STATE"
    printf '## Counts\n\n'
    awk '{ last[$1]=$2 } END {
            for (i in last) { t=last[i]
              if (t ~ /^[0-9]+$/) { if (t=="0") d++; else f++ }
              else if (t ~ /^DEFERRED-/) df++
              else if (t ~ /^BLOCKED-/) b++
              else if (t == "INTERRUPTED") it++
              n++ }
            printf "- queue lines with a row: %d\n- done (exit 0): %d\n- failed (non-zero exit): %d\n- deferred: %d\n- blocked: %d\n- interrupted: %d\n",
                   n+0, d+0, f+0, df+0, b+0, it+0 }' "$STATE" 2>/dev/null
    printf '\n## Stories\n\n| id | outcome | time (UTC) | reason | RESULT line |\n|---|---|---|---|---|\n'
    # EVERY queue line this run offered, in queue order, whether or not it has
    # a state row. A story the walk never reached — the usage limit stopped it,
    # the deadline passed, the runner died — would otherwise be missing from
    # the report altogether, while the header promises nothing is dropped
    # silently and the narrative prompt promises every id appears. Ids that
    # carry a row but are no longer in the queue follow them.
    { queue_ids; awk '!seen[$1]++ { print $1 }' "$STATE" 2>/dev/null; } | awk 'NF && !s[$0]++' |
    while read -r id; do
      row=$(awk -v i="$id" '$1==i' "$STATE" 2>/dev/null | tail -1)
      rcline=$(grep -o 'RESULT .*' "$LOGS/$id.log" 2>/dev/null | tail -1)
      if [ -z "$row" ]; then
        printf '| %s | not reached | - | - | %s |\n' "$id" "${rcline:--}"
        continue
      fi
      read -r rid tok iso reason <<<"$row"
      printf '| %s | %s | %s | %s | %s |\n' "$rid" "$tok" "${iso:--}" "${reason:--}" "${rcline:--}"
    done
    printf '\n## Quota\n\n'
    if grep -q ' DEFERRED-quota' "$STATE" 2>/dev/null; then
      printf 'The model usage limit cut this night short. These queue lines did NOT run and must be re-queued (their rows are non-terminal on purpose):\n\n'
      awk '$2 ~ /^DEFERRED-quota/ { printf "- `%s` — %s, %s (recorded %s)\n", $1, $2, ($4==""?"reset time unknown":$4), $3 }' "$STATE" 2>/dev/null
      if [ -f "$QUOTA_FILE" ]; then
        printf '\nNo session was allowed to start before %s (the announced reset plus QUOTA_MARGIN_SEC=%s).\n' \
          "$(date -u -d "@$(quota_until)" +%FT%TZ 2>/dev/null || echo unknown)" "$QUOTA_MARGIN_SEC"
      fi
    else
      printf 'No usage limit was hit tonight.\n'
    fi
    # shellcheck disable=SC2016  # the backticks are markdown code spans
    printf '\n## Runner facts\n\n- state file: `%s`\n- runner log: `%s`\n- deadline: %s\n- base worktree: `%s`\n- night dir: `%s`\n' \
      "$STATE" "$LOGS/runner.log" "$log_deadline" "$BASE" "$NIGHT_DIR"
    printf '\n'
  } >"$out" 2>/dev/null
}
write_report(){ # the deterministic report FIRST, then one fresh session for the narrative
  local out=$NIGHT_DIR/REPORT-$RUN_DATE.md rc rpid qe
  log "REPORT start -> $out"
  report_deterministic "$out"
  [ -s "$out" ] && log "REPORT deterministic part written -> $out"
  # The narrative is a launch site like any other: it must not start while the
  # usage limit is still in force. It NEVER waits for one, though. The report is
  # the last thing the run does, and the walk that led here ended for its OWN
  # reason (STOP, the disk floor, the deadline) — so a wait here buys nothing
  # and costs everything: the runner would sit on run.flock, the whole project,
  # for up to QUOTA_MAX_WAIT_SEC with not one session running. The deterministic
  # report is already on disk and the owner reads it in the morning, not at 4am.
  qe=$(quota_until) || qe=""
  if [ -n "$qe" ] && [ "$qe" -gt "$(date +%s)" ]; then
    log "REPORT narrative skipped — quota resets at $(date -u -d "@$qe" +%FT%TZ); the deterministic report stands ($out)"
    return 0
  fi
  ( exec 9>&-; cd "$BASE" && env -u CLAUDECODE timeout -k 60 1800 "$CLAUDE_BIN" -p "Write the night report for the $PROJECT overnight run of $RUN_DATE. Read these with Bash, change nothing else: $STATE; $LOGS/runner.log; the RESULT lines from grep -h 'RESULT ' $LOGS/*.log; $BASE/runtime/AUTOPILOT-REPORT.md; $BASE/runtime/handoff/night-*.md; $BASE/runtime/DECISIONS.md if present; gh pr list -R $REPO --state all --limit 20 --json number,title,state,mergedAt,headRefName; and brain next $PROJECT. Write $out in English with: $STATE holds THIS run's rows only, one or more per queue line, as '<id> <rc|TOKEN> <ISO time> [reason]'. A numeric second field is a story that ran and its exit code. Every other second field is a runner-side outcome with the reason in the rest of the line: BLOCKED-queue (malformed queue line), BLOCKED-criteria (the queue line carried no acceptance criteria), BLOCKED-needs (the needs column held no PR number), BLOCKED-needs-unknown (gh could not say whether the dependency PR is merged), BLOCKED-brief (the per-story brief could not be rendered, so the story was never launched), BLOCKED-deadline (no time left before the hard deadline), DEFERRED-needs (the dependency PR was not merged in time), DEFERRED-alive (a session from an earlier pass or an earlier runner was still alive in that story's worktree, so it was not started a second time) and INTERRUPTED (the runner was signalled and killed that story mid-flight — say so, and say the story must be re-queued). When an id has several rows the LAST one is its outcome and the earlier ones are its history. Every id in $STATE is a queue line that MUST appear in the table and in section 4, never be omitted, and so is every id the deterministic '## Stories' table above lists as 'not reached' — those are queue lines the run never got to and they must be re-queued. 1) a one-paragraph summary (stories attempted, merged, open, parked, blocked, plus blocked-before-start); 2) one table row per story: id, result, PR, merged or open, review verdict and rounds, tests run; 3) decisions taken on the owner's behalf; 4) PARKED and BLOCKED items with reasons, naming which floor was hit (review, timeout, context, ci, forbidden or tests); 5) any story reported merged or open with reason=review, flagged as a contradiction; 6) LET'S REVIEW THIS TOGETHER in priority order; 7) worktrees under $NIGHT_DIR/wt that are dirty, unpushed or parked and must be kept; 8) what the Brain recommends next. Then run: update-monitor note \"$PROJECT overnight run $RUN_DATE: <one line with PR numbers>\" and brain note night run $RUN_DATE: <one line>. Do NOT rewrite or delete what is already in $out — it was written from the state rows and it is the ground truth; APPEND your narrative to it under the heading '## Narrative'. Finish with the line REPORT WRITTEN $out" \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/report.log" 2>&1 &
  # BACKGROUNDED AND POLLED, exactly like a story: this session may run for up
  # to 1800 s, and in the foreground the runner beat NOT ONCE in that window —
  # a live runner that the watcher would have called STALLED after 180 s and
  # (once the run ends and the lock drops) restarted.
  rpid=$!; REPORT_PID=$rpid
  await_session "$rpid"; rc=$?
  REPORT_PID=""
  log "REPORT rc=$rc $(grep -o 'REPORT WRITTEN .*' "$LOGS/report.log" | tail -1)"
  if [ "$rc" -ne 0 ]; then
    classify_result report "$rc" "$LOGS/report.log"
    case "$CLASS_TOKEN" in
      DEFERRED-quota*)
        quota_arm "$QUOTA_RESET_EPOCH"
        # Deliberately NOT another wait: the facts are already on disk and the
        # owner reads them in the morning, not at 4am.
        log "REPORT narrative hit the usage limit ($CLASS_TOKEN $CLASS_REASON) — keeping the deterministic report $out, not waiting again";;
    esac
  fi
  # A narrative session that appended nothing must not leave an empty file.
  [ -s "$out" ] || report_deterministic "$out"
  return 0
}

finish(){
  log "RUN end — state ($STATE):"
  tee -a "$LOGS/runner.log" 9>&- <"$STATE"
  if [ $DRY -eq 0 ]; then
    write_report
    # THE LAST ACT of a real run, after the report: its absence next to a stale
    # heartbeat is what tells the watcher the run died rather than ended.
    date +%s >"$FINISHED" 2>/dev/null || log "WARNING: could not write $FINISHED"
    log "FINISHED $(cat "$FINISHED" 2>/dev/null)"
  fi
  exit 0
}

# ------------------------------------------------------ the watcher's inputs --
# The watchdog is a separate script (night-watch.sh) with a separate life: it
# outlives a runner that dies, and restarts it. These two files are its whole
# input, and they are written AFTER the lock, so a file on disk always belongs
# to a run that really owns the night.
publish_run_inputs(){
  local a
  # These two are NIGHT-SCOPED and owned by the run that takes the night.
  # Yesterday's `finished` tells tonight's watcher the run has already ended
  # (so it never restarts a run that dies), and yesterday's watch.restarts is
  # the crash hint a starting watcher reads, so it would open the night with
  # its whole restart budget already spent. They are cleared here,
  # under the lock, and `finished` is written again only by finish().
  # $STOP is deliberately NOT touched: it is the owner's kill switch, and a
  # STOP placed before the run must still stop the night.
  rm -f "$FINISHED" "$NIGHT_DIR/watch.restarts" 2>/dev/null || true
  # argv[0] first (the absolute path of this script), then the original
  # arguments, one per line — `mapfile -t a <run.args; setsid "${a[@]}"` is an
  # exact re-exec. One line per word is what keeps a quoted --deadline intact.
  : >"$RUN_ARGS" 2>/dev/null || { log "WARNING: could not write $RUN_ARGS"; return 0; }
  for a in ${ORIG_ARGV[@]+"${ORIG_ARGV[@]}"}; do printf '%s\n' "$a" >>"$RUN_ARGS"; done
  # PIN THE NIGHT. RUN_DATE is recomputed at every start and the state file is
  # per date, so a watcher restart across LOCAL MIDNIGHT would re-exec into an
  # empty state-<tomorrow>.txt and run the whole queue again — merged stories
  # included. The re-exec therefore always carries this night's own date.
  [ -n "$RUN_DATE_ARG" ] || printf -- '--date\n%s\n' "$RUN_DATE" >>"$RUN_ARGS"
  {
    printf 'pgid=%s\n' "$MY_PGID"
    printf 'started_epoch=%s\n' "$(date +%s)"
    printf 'deadline_epoch=%s\n' "$DEADLINE_EPOCH"
    printf 'run_date=%s\n' "$RUN_DATE"
    printf 'base=%s\n' "$BASE"
    printf 'night_dir=%s\n' "$NIGHT_DIR"
    printf 'skill_dir=%s\n' "$SKILL_DIR"
    printf 'config=%s\n' "$MY_CONFIG"
    printf 'mode=%s\n' "$RUN_MODE"
  } >"$RUN_META" 2>/dev/null || log "WARNING: could not write $RUN_META"
  beat
}
# Spawning it can never fail the run: a night without a watchdog is worth much
# more than no night. Restarting the runner is safe now ONLY because the lock
# is an flock — a restart that races the old runner simply loses it and exits.
spawn_watcher(){
  local w=$SKILL_DIR/night-watch.sh
  if [ "$WATCH_INTERVAL" -eq 0 ]; then
    log "watcher disabled (WATCH_INTERVAL=0)"
    return 0
  fi
  if [ -z "$SKILL_DIR" ] || [ ! -f "$w" ]; then
    log "WARN no watchdog: $w does not exist — nothing will restart this run if it dies"
    return 0
  fi
  # fd 9 closed: a watcher holding the run lock would keep the project locked
  # long after this runner is gone, and it is the one process meant to outlive it.
  ( exec 9>&-; exec "$SETSID" bash "$w" --config "$CONFIG" ) </dev/null >>"$NIGHT_DIR/watch.log" 2>&1 &
  log "watcher started (pid $!, interval ${WATCH_INTERVAL}s, max restarts $WATCH_MAX_RESTARTS, log $NIGHT_DIR/watch.log)"
  return 0
}

# ----------------------------------------------------------------- modes -----
if [ $REPORT_ONLY -eq 1 ]; then
  # --dry-run means "launches nothing, takes no lock" in EVERY mode.
  if [ $DRY -eq 1 ]; then
    echo "=== --dry-run --report: would take $LOCK, then run one report session in $BASE reading $STATE and write $NIGHT_DIR/REPORT-$RUN_DATE.md. Nothing was launched, no lock was taken."
    exit 0
  fi
  # NOTHING is published to the watcher here, and no `finished` is written:
  # run.args, run.meta and finished belong to the QUEUE run that owns the
  # night. A --report run that overwrote them told a watcher polling a DEAD
  # queue run that the night was a report run and had already finished, so the
  # watcher logged its mode gate and exited instead of restarting it.
  acquire_lock; write_report
  exit 0
fi
if [ $SMOKE -eq 1 ]; then
  if [ $DRY -eq 1 ]; then
    echo "=== --dry-run --smoke: would take $LOCK, then run one 300s session in $BASE (model $MODEL, mode $PERM_MODE). Nothing was launched, no lock was taken."
    exit 0
  fi
  # Same rule as --report: the smoke test takes the lock, but it is not the
  # night and publishes nothing to the watcher.
  acquire_lock
  log "SMOKE start (project=$PROJECT base=$BASE mode=$PERM_MODE model=$MODEL)"
  # BACKGROUNDED AND POLLED like every other session: `timeout -k 60 300` is up
  # to 360 s, and run in the foreground this mode beat not once in that window
  # — a runner the watcher would have called STALLED while it was working
  # perfectly. REPORT_PID is what the INT/TERM traps signal.
  ( exec 9>&-; cd "$BASE" && env -u CLAUDECODE timeout -k 60 300 "$CLAUDE_BIN" -p "Run 'brain here' via Bash and then reply with exactly: SMOKE OK <the branch name brain here printed>. Change nothing." \
      --permission-mode "$PERM_MODE" "${EXTRA[@]}" --output-format text </dev/null ) >"$LOGS/smoke.log" 2>&1 &
  REPORT_PID=$!
  await_session "$REPORT_PID"; rc=$?
  REPORT_PID=""
  log "SMOKE rc=$rc last line: $(tail -1 "$LOGS/smoke.log")"; exit $rc
fi

[ -f "$QUEUE" ] || { echo "run.sh: queue file not found: $QUEUE" >&2; exit 2; }
# Without the brief there are no worktree rules, no review loop and no merge
# gate — the whole night would run against a nonexistent path and exit 0.
[ -f "$BRIEF" ] || { echo "run.sh: the rendered brief was not found: $BRIEF" >&2; echo "run.sh: PHASE C of the skill renders it; without it no story has worktree rules, a review loop or a merge gate. Refusing to start." >&2; exit 2; }
if [ $DRY -eq 0 ]; then
  acquire_lock
  publish_run_inputs
  spawn_watcher
  disk_ok || { log "REFUSING to start: free disk $(free_gb_or_unknown)G is below DISK_FLOOR_GB=${DISK_FLOOR_GB}G (or could not be read)"; exit 4; }
fi

# ------------------------------------------------------------- the queue -----
# Up to three passes. Pass one runs everything whose `needs` is already
# satisfied and records a state row for every story it starts. A later pass
# picks up ONLY the items an earlier one never started: because their `needs`
# PR was not merged yet, or because the usage limit deferred them (a
# DEFERRED-quota row is non-terminal for exactly this reason, and the wait
# happens inside the pass, so the re-pick is the only thing left to do). A pass
# that deferred nothing ends the walk, so the usual night is still one pass — is_done skips anything that already ran or was blocked for good, so a
# story that ran and FAILED is never retried the same night; it is reported and
# re-queued by the next /bajzi:night-run. A DEFERRED row does not count as done.
log "RUN start (project=$PROJECT dry=$DRY one=${ONE:-all} deadline=$log_deadline model=$MODEL ci_wait=${CI_WAIT_MINUTES}m state=$STATE)"
one_matched=0
for pass in 1 2 3; do
  deferred=0
  quota_deferred=0
  while IFS='|' read -r id slug needs note || [ -n "${id:-}" ]; do
    beat
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
    # The watcher (and a human) writes its REASON into STOP, so the morning
    # report can say why the night ended instead of "a file existed".
    [ -e "$STOP" ] && { log "STOP file present — stopping before $id. $STOP says: $(head -1 "$STOP" 2>/dev/null || echo '<empty>')"; finish; }
    past_deadline && { log "deadline $log_deadline passed — stopping before $id"; finish; }
    if [ $DRY -eq 1 ]; then
      # A dry run previews the whole queue, gated items included, and never
      # calls gh: it annotates the gate instead of evaluating it.
      case "$needs" in ""|-|none|NONE) :;; *) printf '### %s is gated on PR #%s being MERGED in %s\n' "$id" "$(printf '%s' "$needs" | tr -dc '0-9')" "$REPO";; esac
      run_story "$id" "$slug" "$note"
      [ "$QUEUE_ACTION" = "stop" ] && finish
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
    # run_story's RETURN VALUE is the story's exit code and says nothing about
    # what the queue should do next; QUEUE_ACTION does. Ignoring it is how the
    # first quota-stopped night burned through its whole queue in ninety
    # seconds, one four-second failure per story.
    case "$QUEUE_ACTION" in
      stop) finish;;
      wait)
        quota_deferred=$((quota_deferred + 1))
        quota_wait || finish;;
    esac
  done <"$QUEUE"
  [ $(( deferred + quota_deferred )) -eq 0 ] && break
  [ $DRY -eq 1 ] && break
done
if [ -n "$ONE" ] && [ "$one_matched" -eq 0 ]; then
  log "WARNING: --one $ONE matched no line in $QUEUE — nothing ran"
fi
finish
