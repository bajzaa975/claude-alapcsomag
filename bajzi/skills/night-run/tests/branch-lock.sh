#!/usr/bin/env bash
# Proves the optional config.env key BRANCH_LOCK_CMD: an external per-branch lock
# around every story. run.sh calls the adapter with a fixed argv, never a shell
# string, each call under `timeout 30`:
#   acquire <worktree> <lock-id> | heartbeat <lock-id> | release <lock-id>
# (lock-id = exactly 8 lowercase hex chars; acquire exit 1 = held, stdout line 1 = holder).
#   1.4  relative / missing / non-executable path -> exit 2 before any story;
#        an absolute executable path -> accepted
#   2.1  held  -> no session, DEFERRED-locked holder=<text>, runner.log names the holder
#   2.2  error -> no session, BLOCKED-lock
#   2.3  hang  -> BLOCKED-lock once the 30 s timeout fires
#   2.4  ok    -> the worktree exists on <ns>/<prefix>-<id>-<slug> before acquire
#                 (fresh branch, remote-only branch, existing tree), worktrees.tsv
#                 rows for the trees run.sh created; a tree on another branch -> BLOCKED-lock
#   2.5  a garbage holder is cut to one printable line of <= 200 chars
#   2.6  the story's own leftover lock id is released BEFORE the new acquire;
#        a malformed leftover id is never passed to the adapter
#   2.7  a leftover id whose session is still alive -> DEFERRED-alive, no release
#   2.8  a dry run calls the adapter 0 times
#   3.1  heartbeat every >= 30 s while the story runs
#   3.2  release after the session ended, .lockid removed
#   3.3  a story killed by its own timeout -> released, the next story runs
#   3.4  TERM to the runner -> released, INTERRUPTED row, exit 143
#   3.5  STOP -> finish: every acquire has its release
#   3.6  a failing heartbeat -> one WARNING, the story completes
#   +    without BRANCH_LOCK_CMD nothing changes: no adapter, no pre-created worktree
# Non-dry cases need Linux (setsid, flock, pgrep, /proc); the slow ones run in parallel.
#
# Usage:  bash tests/branch-lock.sh      (~2 min)
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

T=$NR_SCRATCH/branch-lock
rm -rf "$T"; mkdir -p "$T"
has(){ grep -qF -- "$2" "$1"; }
yes_no(){ if eval "$1"; then ok "$2"; else bad "$2"; fi; }

# The STUB adapter: appends "$*" to lock.log, answers per $D/mode.<op> (ok when
# absent). On acquire it also records the branch the worktree is on right now.
mk_stub(){ # <path> <dir>
  mkdir -p "$2"; : >"$2/lock.log"
  { printf '#!/usr/bin/env bash\nD=%q\n' "$2"; cat <<'S'
printf '%s\n' "$*" >>"$D/lock.log"
op=${1:-}
if [ "$op" = acquire ] && [ -d "${2:-}" ]; then
  printf '%s %s\n' "$2" "$(git -C "$2" rev-parse --abbrev-ref HEAD 2>&1)" >>"$D/tree.log"
fi
mode=$(cat "$D/mode.$op" 2>/dev/null || echo ok)
case "$mode" in
  ok) exit 0;;
  held) echo "alice since 2026-10-19T01:00Z"; echo "second line"; exit 1;;
  garbage) printf 'bob\033[31m\a'; printf 'x%.0s' $(seq 1 500); printf '\nsecond line\n'; exit 1;;
  err) echo "adapter exploded" >&2; exit 7;;
  hang) exec -a "$D/hang-sleep" sleep 300;;
esac
exit 9
S
  } >"$1"; chmod 0755 "$1"
}

# ================================================= 1.4 + 2.8: config (dry runs) =
dry(){ # <name> [config lines] -> ND OUT RC
  ND=$T/$1; shift
  nr_make_night "$ND"; nr_queue "$ND" S1
  nr_config "$ND/config.env" "$ND" "$ND" "$ND/no-claude" "$@"
  ( cd "$T" && bash "$NR_RUN" --config "$ND/config.env" --dry-run >"$ND/out" 2>&1 ); RC=$?
  OUT=$ND/out
}
mkdir -p "$T/bin"; printf 'not a script\n' >"$T/bin/plain"; chmod 0644 "$T/bin/plain"
mk_stub "$T/bin/okcmd" "$T/bin/okcmd.d"
for v in "relative/lockcmd" "/no/such/lockcmd" "$T/bin/plain"; do
  dry c14 "BRANCH_LOCK_CMD=\"$v\""
  if [ "$RC" -eq 2 ] && has "$OUT" "BRANCH_LOCK_CMD" && ! has "$OUT" "=== S1"; then ok "1.4 '$v' refused: exit 2 naming BRANCH_LOCK_CMD, no story"
  else bad "1.4 '$v': rc $RC, $(head -2 "$OUT" | tr '\n' '|' | cut -c1-200)"; fi
done
dry c14ok "BRANCH_LOCK_CMD=\"$T/bin/okcmd\""
if [ "$RC" -eq 0 ] && has "$OUT" "=== S1"; then ok "1.4 an absolute executable path is accepted"
else bad "1.4 absolute executable: rc $RC, $(head -2 "$OUT" | tr '\n' '|' | cut -c1-200)"; fi
yes_no '[ ! -s "$T/bin/okcmd.d/lock.log" ]' "2.8 the dry run called the lock command 0 times"

# ============================================================ non-dry fixtures =
need_linux(){ local t; for t in setsid flock pgrep; do command -v "$t" >/dev/null 2>&1 || return 1; done; [ -d /proc/self ]; }
if ! need_linux; then
  bad "the non-dry cases need setsid, flock, pgrep and /proc — run this file on Linux"
  nr_summary branch-lock.sh; exit
fi

mk_repo(){ # <dir>: $dir/origin.git (bare, main) and $dir/base (its clone + the allowlist file)
  local d=$1 g=(git -c user.name=t -c user.email=t@example.invalid)
  git init -q --bare -b main "$d/origin.git"
  git init -q -b main "$d/seed"
  printf 'fixture\n' >"$d/seed/README.md"
  "${g[@]}" -C "$d/seed" add README.md && "${g[@]}" -C "$d/seed" commit -q -m init
  git -C "$d/seed" push -q "$d/origin.git" main
  git clone -q "$d/origin.git" "$d/base"
  mkdir -p "$d/base/.claude"; printf '{ "permissions": { "allow": [] } }\n' >"$d/base/.claude/settings.local.json"
}
use(){ D=$T/$1; ND=$D/nd; LK=$D/lk; CFG=$D/cfg.env; LOG=$ND/logs/runner.log; }
# The shared fake claude behind a wrapper that writes 'session-end' into lock.log
# when a session returns, so session and adapter calls are ordered in ONE file.
setup(){ # <name> [--nolock] [config lines]
  use "$1"; shift
  local lockline="BRANCH_LOCK_CMD=\"$D/lockcmd\""
  [ "${1:-}" = --nolock ] && { lockline=""; shift; }
  mkdir -p "$D"; mk_repo "$D"; nr_make_night "$ND"; mk_stub "$D/lockcmd" "$LK"
  nr_fake_claude "$D/claude.real" "$ND/fake"
  printf '#!/usr/bin/env bash\n%q "$@"; rc=$?\nprintf "session-end\\n" >>%q\nexit $rc\n' "$D/claude.real" "$LK/lock.log" >"$D/claude"
  chmod 0755 "$D/claude"
  nr_config "$CFG" "$ND" "$D/base" "$D/claude" 'BRANCH_NAMESPACE="bajzi"' ${lockline:+"$lockline"} "$@"
}
run(){ setsid -w bash "$NR_RUN" --config "$CFG" >"$D/out.txt" 2>&1; }
row(){ awk -v id="$1" '$1==id' "$ND"/state-*.txt 2>/dev/null | tail -1; }
first(){ grep -n -- "$1" "$LK/lock.log" 2>/dev/null | head -1 | cut -d: -f1; }   # first lock.log line matching
last(){ grep -n -- "$1" "$LK/lock.log" 2>/dev/null | tail -1 | cut -d: -f1; }
acq_id(){ awk -v t="$ND/wt/$1" '$1=="acquire" && $2==t && $3 ~ /^[0-9a-f]{8}$/ { print $3; exit }' "$LK/lock.log"; }
balanced(){ # every acquired id has a release AFTER its acquire
  awk '$1=="acquire"{a[$3]=NR} $1=="release"{r[$2]=NR} END{for(i in a) if(!(i in r) || r[i]<a[i]) exit 1}' "$LK/lock.log"
}
wait_for(){ local i; for i in $(seq 1 150); do eval "$1" && return 0; sleep 0.2; done; return 1; }

# ------------------------------------------- the slow cases, started in parallel -
setup hang; echo hang >"$LK/mode.acquire"; nr_queue "$ND" S1; nr_plan "$ND/fake" ok
( t0=$(date +%s); run; echo $(( $(date +%s) - t0 )) >"$D/secs" ) &
setup beat; nr_queue "$ND" S1 S2; nr_plan "$ND/fake" "ok:80" "ok"
( run & p=$!; wait_for "grep -q '^acquire ' '$LK/lock.log'"; touch "$ND/STOP"; wait "$p" ) &
setup tmo 'PER_STORY_TIMEOUT="60"'; nr_queue "$ND" S1 S2; nr_plan "$ND/fake" "hang:200" "ok" "ok"
( run ) &
setup term; nr_queue "$ND" S1; nr_plan "$ND/fake" "ok:60"
( setsid bash "$NR_RUN" --config "$CFG" >"$D/out.txt" 2>&1 & p=$!
  wait_for "grep -q ' START S1 (' '$LOG' 2>/dev/null"; sleep 1; kill -TERM "$p"; wait "$p"; echo $? >"$D/rc" ) &
setup hbfail; echo err >"$LK/mode.heartbeat"; nr_queue "$ND" S1; nr_plan "$ND/fake" "ok:45" "ok"
( run ) &

# ---------------------------------------------------------- the fast cases ------
echo "== default: no BRANCH_LOCK_CMD =="
setup nolock --nolock; nr_queue "$ND" S1; run
yes_no '[ -n "$(row S1 | grep "^S1 0 ")" ]' "+ default: S1 ran (exit 0)"
yes_no '[ ! -e "$ND/wt/S1" ] && [ ! -e "$ND/worktrees.tsv" ]' "+ default: run.sh pre-created no worktree"
yes_no '[ ! -s "$LK/lock.log" ] || ! grep -qv "^session-end$" "$LK/lock.log"' "+ default: no adapter call"

echo "== 2.1 held =="
setup held; echo held >"$LK/mode.acquire"; nr_queue "$ND" S1; nr_plan "$ND/fake" ok; run
r=$(row S1); printf 'S1 row: %s\n' "${r:-<none>}"
yes_no 'printf "%s" "$r" | grep -qE "^S1 DEFERRED-locked [^ ]+ holder=alice since 2026-10-19T01:00Z\$"' "2.1 DEFERRED-locked row with holder=alice since …"
yes_no 'grep -q "alice since 2026-10-19T01:00Z" "$LOG"' "2.1 runner.log names the holder"
yes_no '! grep -q " START S1 (" "$LOG"' "2.1 no session for S1"
yes_no '! grep -q "^release " "$LK/lock.log" && [ ! -e "$ND/story/S1.lockid" ]' "2.1 nothing to release, no .lockid left"

echo "== 2.2 error =="
setup err; echo err >"$LK/mode.acquire"; nr_queue "$ND" S1; nr_plan "$ND/fake" ok; run
r=$(row S1); printf 'S1 row: %s\n' "${r:-<none>}"
yes_no 'printf "%s" "$r" | grep -qE "^S1 BLOCKED-lock .*exited 7.*adapter exploded"' "2.2 BLOCKED-lock row with the adapter's error"
yes_no '! grep -q " START S1 (" "$LOG"' "2.2 no session for S1"

echo "== 2.4 ok: the three worktree cases and a wrong-branch tree =="
setup okt; nr_queue "$ND" S1 S2 S3 S4; nr_plan "$ND/fake" ok
git -C "$D/seed" push -q "$D/origin.git" main:refs/heads/bajzi/nrt-S2-slug
git -C "$D/base" fetch -q origin
git -C "$D/base" worktree add -q -b bajzi/nrt-S3-slug "$ND/wt/S3" origin/main
git -C "$D/base" worktree add -q -b other "$ND/wt/S4" origin/main
run
for s in S1 S2 S3; do
  yes_no '[ -n "$(acq_id $s)" ]' "2.4 $s: acquire $ND/wt/$s <8hex>"
  yes_no 'grep -qxF "$ND/wt/$s bajzi/nrt-$s-slug" "$LK/tree.log"' "2.4 $s: the worktree was on bajzi/nrt-$s-slug at acquire"
  yes_no '[ -n "$(row $s | grep "^$s 0 ")" ]' "2.4 $s ran (exit 0)"
done
for s in S1 S2; do
  yes_no 'awk -F"\t" -v s=$s -v p="$ND/wt/$s" -v b=bajzi/nrt-$s-slug "\$1==s && \$2==p && \$3==b && \$4 ~ /^[0-9-]+T/ {f=1} END{exit !f}" "$ND/worktrees.tsv"' "2.4 $s: worktrees.tsv row"
done
yes_no '! awk -F"\t" "\$1==\"S3\"" "$ND/worktrees.tsv" | grep -q .' "2.4 S3: an existing tree adds no worktrees.tsv row"
r=$(row S4); printf 'S4 row: %s\n' "${r:-<none>}"
yes_no 'printf "%s" "$r" | grep -qE "^S4 BLOCKED-lock .*not bajzi/nrt-S4-slug" && ! grep -q "wt/S4 " "$LK/lock.log"' "2.4 S4: a tree on another branch is BLOCKED-lock, never acquired"
yes_no 'balanced && [ -z "$(ls "$ND"/story/*.lockid 2>/dev/null)" ]' "2.4 every acquire released, no .lockid left"
yes_no '[ "$(first "^release $(acq_id S1)")" -gt "$(first "^session-end")" ]' "2.4 S1 released after its session ended"

echo "== 2.5 garbage holder =="
setup garb; echo garbage >"$LK/mode.acquire"; nr_queue "$ND" S1; nr_plan "$ND/fake" ok; run
r=$(row S1); h=${r#*holder=}; printf 'S1 row: %s\n' "$(printf '%s' "$r" | cut -c1-120)…"
yes_no 'printf "%s" "$r" | grep -q "^S1 DEFERRED-locked .* holder=bob"' "2.5 DEFERRED-locked holder=bob…"
yes_no '[ "${#h}" -le 200 ] && [ "${#h}" -ge 150 ]' "2.5 holder cut to <= 200 chars (got ${#h})"
yes_no '! LC_ALL=C grep -q "[^[:print:]]" "$ND"/state-*.txt && ! grep -q "second line" "$ND"/state-*.txt' "2.5 state file: one printable line, no second line"
yes_no 'grep -q "bob" "$LOG" && ! grep -o "bob.*" "$LOG" | LC_ALL=C grep -q "[^[:print:]]" && ! grep -q "second line" "$LOG"' "2.5 runner.log: the holder is printable only, no second line"

echo "== 2.6 leftover lock id, its session dead =="
setup left; nr_queue "$ND" S1 S2; nr_plan "$ND/fake" ok
echo deadbeef >"$ND/story/S1.lockid"; nr_dead_pid >"$ND/story/S1.sid"
echo 'not-an-id;rm -rf x' >"$ND/story/S2.lockid"
run
yes_no '[ -n "$(first "^release deadbeef$")" ] && [ "$(first "^release deadbeef$")" -lt "$(first "^acquire $ND/wt/S1 ")" ]' "2.6 release deadbeef BEFORE the new acquire"
yes_no '! grep -q "not-an-id" "$LK/lock.log" && grep -q "WARNING S2" "$LOG"' "2.6 a malformed leftover id is never passed on (WARNING instead)"
yes_no '[ -n "$(row S1 | grep "^S1 0 ")" ] && [ ! -e "$ND/story/S1.lockid" ]' "2.6 S1 ran and its .lockid is gone"

echo "== 2.7 leftover lock id, its session alive =="
setup alive; nr_queue "$ND" S1; nr_plan "$ND/fake" ok
setsid -w sleep 25 >/dev/null 2>&1 &
apid=$!
echo deadbeef >"$ND/story/S1.lockid"; printf '%s\n' "$apid" >"$ND/story/S1.sid"
run
yes_no '[ -n "$(row S1 | grep "^S1 DEFERRED-alive .*sid=$apid\$")" ]' "2.7 DEFERRED-alive"
yes_no '! grep -q "^release deadbeef" "$LK/lock.log" && ! grep -q "^acquire " "$LK/lock.log" && grep -qx deadbeef "$ND/story/S1.lockid"' "2.7 the live session's lock is not released"
kill -TERM "$apid" 2>/dev/null; wait "$apid" 2>/dev/null

# --------------------------------------------------- the slow cases: verdicts ---
echo "== waiting for the parallel cases =="
wait

echo "== 2.3 hang =="
use hang; r=$(row S1); s=$(cat "$D/secs" 2>/dev/null); printf 'S1 row: %s (run %ss)\n' "${r:-<none>}" "${s:-?}"
yes_no 'printf "%s" "$r" | grep -qE "^S1 BLOCKED-lock .*timed out after 30s"' "2.3 a hanging acquire is BLOCKED-lock (timed out)"
yes_no '[ "${s:-999}" -le 60 ] && ! grep -q " START S1 (" "$LOG"' "2.3 within the timeout, and no session"

echo "== 3.1 / 3.2 / 3.5 heartbeat, release, STOP =="
use beat; id=$(acq_id S1); hb=$(grep -c "^heartbeat ${id:-none}\$" "$LK/lock.log")
printf 'lock id %s, %s heartbeat(s)\n' "${id:-<none>}" "$hb"
yes_no '[ "$hb" -ge 2 ]' "3.1 >= 2 heartbeats during an 80 s story"
yes_no '[ "$(last "^heartbeat ")" -lt "$(first "^session-end")" ] && [ "$(first "^session-end")" -lt "$(first "^release $id\$")" ]' "3.2 release after the session ended"
yes_no '[ ! -e "$ND/story/S1.lockid" ] && [ -n "$(row S1 | grep "^S1 0 ")" ]' "3.2 S1 exit 0, .lockid removed"
yes_no 'grep -q "STOP file present" "$LOG" && [ "$(grep -c "^acquire " "$LK/lock.log")" -eq 1 ] && balanced' "3.5 STOP -> finish: one acquire, released"

echo "== 3.3 own timeout =="
use tmo; id=$(acq_id S1)
yes_no '[ -n "$(row S1 | grep "^S1 124 ")" ] && [ -n "$(first "^release ${id:-none}\$")" ]' "3.3 S1 killed by its timeout (124) and released"
yes_no '[ -n "$(row S2 | grep "^S2 0 ")" ] && balanced' "3.3 the runner went on: S2 ran, every acquire released"

echo "== 3.4 TERM =="
use term; id=$(acq_id S1); rc=$(cat "$D/rc" 2>/dev/null)
yes_no '[ "${rc:-x}" = 143 ]' "3.4 the runner exited 143 (got ${rc:-none})"
yes_no '[ -n "$(row S1 | grep "^S1 INTERRUPTED ")" ]' "3.4 INTERRUPTED row"
yes_no '[ -n "$id" ] && [ -n "$(first "^release $id\$")" ] && [ ! -e "$ND/story/S1.lockid" ]' "3.4 the lock was released"

echo "== 3.6 heartbeat failure =="
use hbfail
yes_no '[ "$(grep -c "WARNING.*heartbeat" "$LOG")" -eq 1 ] && grep -q "^heartbeat " "$LK/lock.log"' "3.6 one WARNING line for the failed heartbeat"
yes_no '[ -n "$(row S1 | grep "^S1 0 ")" ] && balanced' "3.6 the story completed and was released"

for n in nolock held err okt garb left alive hang beat tmo term hbfail; do use "$n"; nr_cleanup "$ND"; done
s=$(nr_strays)
yes_no '[ -z "$s" ]' "nothing left running${s:+: $s}"

nr_summary branch-lock.sh
