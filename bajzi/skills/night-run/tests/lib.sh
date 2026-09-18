#!/usr/bin/env bash
# Shared fixtures for the night-runner tests. Sourced, never run on its own.
#
# NOTHING here ever runs the real `claude`, touches a real night directory or
# signals a process the test did not start. Every fixture lives under
# $NR_SCRATCH (default: a per-session scratch dir), and every session the tests
# start is torn down by nr_cleanup, which only ever signals sessions whose sid
# the test itself recorded.

set -u

NR_SKILL_DIR=${NR_SKILL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
# shellcheck disable=SC2034  # used by the tests that source this file
NR_RUN=$NR_SKILL_DIR/run.sh
# ONE scratch convention for all four test files (tests/watch.sh, which does
# not source this library, uses the same variable and the same default).
NR_SCRATCH=${NR_SCRATCH:-${TMPDIR:-/tmp}/night-run-tests}
NR_PASS=0
NR_FAIL=0

ok(){   NR_PASS=$((NR_PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){  NR_FAIL=$((NR_FAIL+1)); printf 'FAIL %s\n' "$*"; }
check(){ # <condition-rc> <description>
  if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; fi
}
nr_summary(){ # prints the tally and returns the script's exit code
  printf '\n%s: %d passed, %d failed\n' "${1:-tests}" "$NR_PASS" "$NR_FAIL"
  [ "$NR_FAIL" -eq 0 ]
}

# ---------------------------------------------------------------- fixtures --
# One BASE worktree is enough for every case: it only has to be a real git repo
# that carries .claude/settings.local.json, because that is all run.sh checks.
nr_make_base(){ # <path>
  local b=$1
  [ -d "$b/.git" ] && return 0
  mkdir -p "$b/.claude"
  git -C "$b" init -q 2>/dev/null || return 1
  printf '{ "permissions": { "allow": [] } }\n' >"$b/.claude/settings.local.json"
  printf 'fixture\n' >"$b/README.md"
  return 0
}

# A NIGHT_DIR with everything run.sh insists on: queue.txt, BRIEF.md, logs/.
# The BRIEF carries exactly the five placeholders the runner substitutes, so
# render_brief succeeds and leaves nothing unrendered.
nr_make_night(){ # <night_dir>
  local nd=$1
  mkdir -p "$nd/logs" "$nd/wt" "$nd/story" "$nd/fake"
  cat >"$nd/BRIEF.md" <<'B'
# Fixture brief
deadline={{STORY_DEADLINE_EPOCH}} finalize={{STORY_FINALIZE_EPOCH}}
ci={{CI_WAIT_MINUTES}} who={{GIT_USER_NAME}} <{{GIT_USER_EMAIL}}>
B
  : >"$nd/queue.txt"
}

nr_queue(){ # <night_dir> <id>...  — one trivial, valid queue line per id
  local nd=$1; shift
  local id
  : >"$nd/queue.txt"
  for id in "$@"; do
    printf '%s|slug|-|acceptance criteria for %s\n' "$id" "$id" >>"$nd/queue.txt"
  done
}

# The FAKE claude. It never talks to a model; it consumes one line of
# $FAKE_DIR/plan per invocation and replays it:
#   ok[:secs]      sleep, print a RESULT line, exit 0
#   limit[:secs]   print the VERBATIM session-limit message with a reset time
#                  <secs> ahead (rounded UP to the next whole minute, because
#                  the real message has no seconds and a truncated one would
#                  land in the past), exit 1
#   weekly[:secs]  the same for the weekly limit
#   hang[:secs]    sleep and exit 0 — a session that outlives its wrapper
#   orphan[:secs]  exit 0 but leave a sleeping member in the story's session,
#                  so the runner's post-wait drain has something to clean up
#   raw:<text>     print <text> verbatim and exit 1 — for limit messages with a
#                  reset time or zone the test wants to pin exactly
# When the plan runs out, the LAST line is repeated.
# It also records, per invocation: the invocation number, its own sid, and its
# whole fd table — that is how the tests prove fd 9 (the run lock) never leaks.
nr_fake_claude(){ # <path> <fake_dir>
  local path=$1 fdir=$2
  mkdir -p "$fdir" "$(dirname "$path")"
  : >"$fdir/plan"; : >"$fdir/launches"; : >"$fdir/fds.log"; printf '0\n' >"$fdir/count"
  cat >"$path" <<FAKE
#!/usr/bin/env bash
set -u
D="$fdir"
FAKE
  cat >>"$path" <<'FAKE'
n=$(( $(cat "$D/count" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$n" >"$D/count"
{
  printf '=== invocation %s pid=%s sid=%s\n' "$n" "$$" "$(ps -o sid= -p $$ 2>/dev/null | tr -d ' ')"
  ls -l "/proc/$$/fd" 2>/dev/null
} >>"$D/fds.log"
printf '%s %s\n' "$n" "$(date +%s)" >>"$D/launches"
line=$(sed -n "${n}p" "$D/plan" 2>/dev/null)
[ -n "$line" ] || line=$(tail -1 "$D/plan" 2>/dev/null)
[ -n "$line" ] || line=ok
arg=${line#*:}; [ "$arg" = "$line" ] && arg=""
mode=${line%%:*}
reset_at(){ # seconds ahead -> the next whole minute at or after now+secs
  local e=$(( $(date +%s) + ${1:-20} ))
  e=$(( (e + 59) / 60 * 60 ))
  printf '%s %s' "$e" "$(date -u -d "@$e" '+%-I:%M%P')"
}
case "$mode" in
  ok)
    [ -n "$arg" ] && sleep "$arg"
    echo "fake session $n did the work"
    echo "RESULT fake merged PR#- reason=-"
    exit 0;;
  limit)
    set -- $(reset_at "${arg:-20}")
    printf '%s\n' "$2" >"$D/last-reset-hhmm"; printf '%s\n' "$1" >"$D/last-reset-epoch"
    echo "You've hit your session limit · resets $2 (UTC)"
    exit 1;;
  weekly)
    set -- $(reset_at "${arg:-20}")
    printf '%s\n' "$2" >"$D/last-reset-hhmm"; printf '%s\n' "$1" >"$D/last-reset-epoch"
    echo "You've hit your weekly limit · resets $2 (UTC)"
    exit 1;;
  hang)
    sleep "${arg:-30}"
    exit 0;;
  orphan)
    # Exit cleanly but leave a member behind in the SAME session: exactly what
    # a claude that forked something long-running does to a story's worktree.
    sleep "${arg:-30}" &
    echo "RESULT fake merged PR#- reason=-"
    exit 0;;
  raw)
    printf '%s\n' "$arg"
    exit 1;;
  *)
    echo "fake claude: unknown plan line '$line'" >&2
    exit 99;;
esac
FAKE
  chmod 0755 "$path"
}

nr_plan(){ # <fake_dir> <line>...
  local fdir=$1; shift
  : >"$fdir/plan"
  local l; for l in "$@"; do printf '%s\n' "$l" >>"$fdir/plan"; done
}

# A config.env the runner accepts. WATCH_INTERVAL=0 on purpose: a test must
# never spawn a watchdog that could restart a runner behind the test's back.
nr_config(){ # <path> <night_dir> <base> <fake_claude> [extra KEY=VALUE]...
  local cfg=$1 nd=$2 base=$3 fake=$4; shift 4
  cat >"$cfg" <<CFG
PROJECT="nr-test"
NIGHT_DIR="$nd"
BASE="$base"
REPO="example/fixture"
BASE_BRANCH="main"
MODEL="fake-model"
PER_STORY_TIMEOUT="120"
BRANCH_PREFIX="nrt"
DISK_FLOOR_GB="1"
REQUIRED_CHECK="CI"
GIT_USER_NAME="Night Fixture"
GIT_USER_EMAIL="fixture@example.invalid"
CI_WAIT_MINUTES="1"
CLAUDE_BIN="$fake"
WATCH_INTERVAL="0"
CFG
  local kv; for kv in "$@"; do printf '%s\n' "$kv" >>"$cfg"; done
}

# A pid that is guaranteed NOT to exist, for the stale-lock fixtures.
nr_dead_pid(){
  local n
  for n in 4194301 4194299 4194297 4194295 4194293; do
    [ -d "/proc/$n" ] || { printf '%s' "$n"; return 0; }
  done
  printf '4194301'
}

# Tear down every session the TEST started, by the sids the runner recorded.
# Nothing outside $NR_SCRATCH is ever looked at, and no pid the test did not
# create is ever signalled.
nr_cleanup(){ # <night_dir>...
  local nd f sid p
  for nd in "$@"; do
    for f in "$nd"/story/*.sid; do
      [ -f "$f" ] || continue
      sid=$(tr -dc '0-9' <"$f" 2>/dev/null)
      case "$sid" in ""|0) continue;; esac
      for p in $(pgrep -s "$sid" 2>/dev/null); do kill -KILL "$p" 2>/dev/null || true; done
    done
  done
}

# Proof that a test left nothing running: any process whose command line still
# mentions the scratch path. A short grace window first, because a session that
# has just been signalled is allowed a moment to die — "still there after three
# seconds" is a leak, "still there in the same millisecond" is scheduling.
nr_strays(){ # prints "<pid> <cmdline>" per stray, if any
  local p out="" waited=0 cmd
  while [ "$waited" -lt 30 ]; do
    out=""
    for p in $(pgrep -f "$NR_SCRATCH" 2>/dev/null); do
      [ "$p" = "$$" ] && continue
      cmd=$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | cut -c1-120)
      [ -n "$cmd" ] || continue
      out="$out$p $cmd
"
    done
    [ -z "$out" ] && break
    sleep 0.1; waited=$((waited + 1))
  done
  printf '%s' "$out"
}
