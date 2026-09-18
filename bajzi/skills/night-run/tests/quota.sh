#!/usr/bin/env bash
# Proves what the runner does when the model says
#   You've hit your session limit · resets 5:50am (UTC)
# — the message that, on 2026-09-18, cost a whole night: it arrives with exit
# code 1 within four seconds, the runner recorded it as "story failed", and the
# queue burned down in ninety seconds with nothing done.
#
#   (A) session limit  -> DEFERRED-quota + resets=<ISO>, NOTHING launches during
#                         the wait, and every story runs after it
#   (B) weekly limit   -> no wait at all, the run finishes and still reports
#   (C) the REPORT session hits the limit -> the deterministic report survives
#   (D) a reset in a named zone, too far away for the --deadline -> parsed
#                         exactly, waited for NEVER, run finishes
#
# Usage:  bash tests/quota.sh
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ROOT=$NR_SCRATCH/quota
rm -rf "$ROOT"; mkdir -p "$ROOT"
BASE=$NR_SCRATCH/shared-base
nr_make_base "$BASE" || { echo "FAIL could not create the fixture BASE worktree"; exit 1; }

setup(){ # <name> <extra config line>... ; sets ND CFG FAKE LOG
  local name=$1; shift
  ND=$ROOT/$name/nd; CFG=$ROOT/$name/cfg.env; FAKE=$ROOT/$name/fake-claude
  mkdir -p "$ROOT/$name"
  nr_make_night "$ND"
  nr_fake_claude "$FAKE" "$ND/fake"
  nr_config "$CFG" "$ND" "$BASE" "$FAKE" "$@"
  LOG=$ND/logs/runner.log
}
row(){ awk -v id="$1" -v tok="$2" '$1==id && $2==tok' "$ND"/state-*.txt 2>/dev/null | tail -1; }
lineno(){ grep -n -- "$1" "$LOG" 2>/dev/null | head -1 | cut -d: -f1; }
report(){ local f; for f in "$ND"/REPORT-*.md; do [ -f "$f" ] && { printf '%s' "$f"; return 0; }; done; return 1; }

# ============================================================ (A) session cap =
echo "== (A) a session limit mid-queue: defer, wait, then finish the queue =="
setup A 'QUOTA_MARGIN_SEC="5"' 'QUOTA_MAX_WAITS="3"'
nr_queue "$ND" S1 S2 S3 S4
# S1 ok, S2 hits the limit with a reset ~20 s out, everything after it ok.
nr_plan "$ND/fake" "ok" "limit:20" "ok" "ok" "ok" "ok"
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/A/out.txt" 2>&1; rcA=$?
tA=$(( $(date +%s) - t0 ))
printf 'run A finished in %ss with exit %s\n' "$tA" "$rcA"

r=$(row S2 DEFERRED-quota)
printf 'S2 quota row: %s\n' "${r:-<none>}"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(A) S2 got a DEFERRED-quota row"
case "$r" in *resets=2*) ok "(A) the row carries a parsed reset time (resets=…)";;
             *) bad "(A) the row carries a parsed reset time (resets=…)";; esac
# The reset the fake announced, resolved independently of the runner.
want=$(date -u -d "@$(cat "$ND/fake/last-reset-epoch" 2>/dev/null || echo 0)" +%FT%TZ 2>/dev/null)
got=${r##*resets=}
printf 'announced reset %s, recorded %s\n' "$want" "$got"
check "$([ -n "$want" ] && [ "$want" = "$got" ] && echo 0 || echo 1)" "(A) the recorded reset equals the announced one"

qw=$(lineno 'QUOTA-WAIT until'); qo=$(lineno 'QUOTA-WAIT over'); s3=$(lineno 'START S3 ('); s4=$(lineno 'START S4 (')
printf 'runner.log lines: QUOTA-WAIT until=%s over=%s START S3=%s START S4=%s\n' "${qw:-none}" "${qo:-none}" "${s3:-none}" "${s4:-none}"
check "$([ -n "$qw" ] && echo 0 || echo 1)" "(A) the runner logged QUOTA-WAIT"
check "$([ -n "$qo" ] && [ -n "$s3" ] && [ "$qo" -lt "$s3" ] && echo 0 || echo 1)" \
      "(A) S3 was not launched until the wait was over"
check "$([ -n "$qo" ] && [ -n "$s4" ] && [ "$qo" -lt "$s4" ] && echo 0 || echo 1)" \
      "(A) S4 was not launched until the wait was over"
for id in S2 S3 S4; do
  check "$([ -n "$(row "$id" 0)" ] && echo 0 || echo 1)" "(A) $id completed (exit 0) after the wait"
done
rep=$(report)
check "$([ -n "$rep" ] && echo 0 || echo 1)" "(A) REPORT-<date>.md exists"
check "$([ -n "$rep" ] && grep -q '^## Quota' "$rep" && echo 0 || echo 1)" "(A) the report has a Quota section"
check "$([ -n "$rep" ] && grep -q 'DEFERRED-quota' "$rep" && echo 0 || echo 1)" "(A) the Quota section names the deferred row"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(A) the run wrote 'finished' as its last act"

# ============================================================= (B) weekly cap =
echo
echo "== (B) a weekly limit: no wait is possible, so finish and report now =="
setup B 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" W1 W2
nr_plan "$ND/fake" "weekly:60" "ok"
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/B/out.txt" 2>&1; rcB=$?
tB=$(( $(date +%s) - t0 ))
printf 'run B finished in %ss with exit %s\n' "$tB" "$rcB"
check "$([ "$tB" -le 30 ] && echo 0 || echo 1)" "(B) the run finished immediately (${tB}s, no wait)"
r=$(row W1 DEFERRED-quota-weekly)
printf 'W1 row: %s\n' "${r:-<none>}"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(B) W1 stayed DEFERRED-quota-weekly"
check "$(grep -q 'WEEKLY limit' "$LOG" && echo 0 || echo 1)" "(B) the runner said why it refused to wait"
check "$(grep -q ' START W2 (' "$LOG" && echo 1 || echo 0)" "(B) W2 was never launched"
rep=$(report)
check "$([ -n "$rep" ] && grep -q '^## Counts' "$rep" && echo 0 || echo 1)" "(B) the deterministic report exists"
check "$([ -n "$rep" ] && grep -q 'DEFERRED-quota-weekly' "$rep" && echo 0 || echo 1)" "(B) the report names the weekly rows"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(B) the run wrote 'finished'"

# ================================================= (C) the report hits the cap =
echo
echo "== (C) the narrative report session hits the limit: the report survives =="
setup C 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" R1
nr_plan "$ND/fake" "ok" "limit:120"
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/C/out.txt" 2>&1; rcC=$?
tC=$(( $(date +%s) - t0 ))
printf 'run C finished in %ss with exit %s\n' "$tC" "$rcC"
check "$([ "$tC" -le 30 ] && echo 0 || echo 1)" "(C) the run did not wait for the report's limit (${tC}s)"
rep=$(report)
check "$([ -n "$rep" ] && echo 0 || echo 1)" "(C) REPORT-<date>.md exists even though the narrative session failed"
check "$([ -n "$rep" ] && grep -q '^## Counts' "$rep" && echo 0 || echo 1)" "(C) it still holds the deterministic counts"
check "$([ -n "$rep" ] && grep -q '| R1 | 0 |' "$rep" && echo 0 || echo 1)" "(C) it still holds R1's row"
check "$(grep -q 'REPORT narrative hit the usage limit' "$LOG" && echo 0 || echo 1)" "(C) the runner logged the narrative's limit"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(C) the run wrote 'finished'"

# ============================== (D) a named zone, and a wait the deadline bars =
echo
echo "== (D) 'resets 11:05pm (Europe/Budapest)' parsed exactly; no wait past the deadline =="
setup D 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" Z1 Z2
nr_plan "$ND/fake" "raw:You've hit your session limit · resets 11:05pm (Europe/Budapest)" "ok"
want=$(date -d 'TZ="Europe/Budapest" 11:05pm' +%s)
[ "$want" -le "$(date +%s)" ] && want=$(date -d 'TZ="Europe/Budapest" tomorrow 11:05pm' +%s)
want=$(date -u -d "@$want" +%FT%TZ)
dl=$(date -d '+3 minutes' +%H:%M)
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" --deadline "$dl" >"$ROOT/D/out.txt" 2>&1; rcD=$?
tD=$(( $(date +%s) - t0 ))
printf 'run D finished in %ss with exit %s (deadline %s)\n' "$tD" "$rcD" "$dl"
r=$(row Z1 DEFERRED-quota)
printf 'Z1 row: %s\n  expected reset: %s\n' "${r:-<none>}" "$want"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(D) Z1 got a DEFERRED-quota row"
check "$([ "${r##*resets=}" = "$want" ] && echo 0 || echo 1)" "(D) the Europe/Budapest reset was parsed exactly"
check "$([ "$tD" -le 30 ] && echo 0 || echo 1)" "(D) the runner did not wait (${tD}s)"
check "$(grep -q 'QUOTA-WAIT refused' "$LOG" && echo 0 || echo 1)" "(D) it refused the wait and said the deadline was why"
check "$([ -n "$(report)" ] && echo 0 || echo 1)" "(D) the report was still written"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(D) the run wrote 'finished'"

# ------------------------------------------------------------------ strays ---
echo
nr_cleanup "$ROOT"/*/nd
strays=$(nr_strays)
[ -n "$strays" ] && printf 'stray processes still on the scratch path:\n%s' "$strays"
check "$([ -z "$strays" ] && echo 0 || echo 1)" "no processes left behind under $NR_SCRATCH"

nr_summary "quota"
