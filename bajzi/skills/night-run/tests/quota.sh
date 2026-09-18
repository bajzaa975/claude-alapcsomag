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
#   (E1) a reset ONE MINUTE in the past (the message is minute-truncated) is
#                         the SAME reset: the wait is the margin, not a day
#   (E2) a reset 20 minutes in the past is TOMORROW's, and a wait that long is
#                         refused by QUOTA_MAX_WAIT_SEC — rows stay deferred,
#                         the report still names the stories never reached
#   (E3) the same reset with a large cap resolves to tomorrow exactly
#   (F)  a limit message followed by 20 more output lines is still found, and
#                         the same message with exit code 0 is never a quota row
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

# ===================================== (E) a reset time that is already past =
# The message is minute-truncated, so the reset it announces is routinely a few
# seconds — or a minute — BEHIND the clock by the time the runner reads it.
# Rolling every such time a full day forward held run.flock for a day.
echo
echo "== (E1) a reset one minute in the past is the SAME reset: wait the margin, not a day =="
setup E1 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" P1 P2
nr_plan "$ND/fake" "past:1" "ok" "ok" "ok"
# The deadline is a SAFETY NET, not the subject: if the rollover regresses, the
# run refuses the (day-long) wait and the checks below fail loudly instead of
# parking this test until tomorrow.
dl=$(date -d '+10 minutes' +%H:%M)
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" --deadline "$dl" >"$ROOT/E1/out.txt" 2>&1; rcE1=$?
tE1=$(( $(date +%s) - t0 ))
printf 'run E1 finished in %ss with exit %s\n' "$tE1" "$rcE1"
r=$(row P1 DEFERRED-quota)
printf 'P1 quota row: %s\n' "${r:-<none>}"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(E1) P1 got a DEFERRED-quota row"
got=${r##*resets=}
gote=$(date -u -d "$got" +%s 2>/dev/null || echo 0)
printf 'recorded reset %s = epoch %s, run started %s (delta %ss)\n' "$got" "$gote" "$t0" "$(( gote - t0 ))"
check "$([ "$gote" -gt 0 ] && [ "$(( gote - t0 ))" -lt 300 ] && echo 0 || echo 1)" \
      "(E1) the reset was treated as NOW, not rolled forward a day"
check "$([ "$tE1" -le 90 ] && echo 0 || echo 1)" "(E1) the whole run took ${tE1}s (the wait was the margin only)"
check "$(grep -q 'QUOTA-WAIT over' "$LOG" && echo 0 || echo 1)" "(E1) the runner really waited and the wait ended"
check "$([ -n "$(row P1 0)" ] && echo 0 || echo 1)" "(E1) P1 ran and completed after the wait"
check "$([ -n "$(row P2 0)" ] && echo 0 || echo 1)" "(E1) P2 ran and completed"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(E1) the run wrote 'finished'"

echo
echo "== (E2) a 20-minute-old reset is tomorrow's — and a wait longer than QUOTA_MAX_WAIT_SEC is refused =="
setup E2 'QUOTA_MARGIN_SEC="5"' 'QUOTA_MAX_WAIT_SEC="60"'
nr_queue "$ND" Q1 Q2
nr_plan "$ND/fake" "past:20" "ok" "ok"
# The cap is what must stop this run. The deadline is only a safety net for a
# regression: without one, a runner that rolls the reset forward a day and
# takes the wait would hold the lock — and this test — until tomorrow.
dl=$(date -d '+10 minutes' +%H:%M)
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" --deadline "$dl" >"$ROOT/E2/out.txt" 2>&1; rcE2=$?
tE2=$(( $(date +%s) - t0 ))
printf 'run E2 finished in %ss with exit %s\n' "$tE2" "$rcE2"
check "$([ "$tE2" -le 60 ] && echo 0 || echo 1)" "(E2) the run finished in ${tE2}s instead of holding the lock for a day"
r=$(row Q1 DEFERRED-quota)
printf 'Q1 row: %s\n' "${r:-<none>}"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(E2) Q1 stayed DEFERRED-quota (non-terminal, the next night picks it up)"
check "$(grep -q 'exceeds QUOTA_MAX_WAIT_SEC' "$LOG" && echo 0 || echo 1)" "(E2) the runner refused the wait and named QUOTA_MAX_WAIT_SEC"
rep=$(report)
check "$([ -n "$rep" ] && echo 0 || echo 1)" "(E2) the deterministic report was still written"
# Q2 was never reached: no state row at all. The report must still list it.
check "$([ -z "$(awk '$1=="Q2"' "$ND"/state-*.txt 2>/dev/null)" ] && echo 0 || echo 1)" "(E2) Q2 was never reached (no state row)"
check "$([ -n "$rep" ] && grep -q '^| Q2 | not reached |' "$rep" && echo 0 || echo 1)" \
      "(E2) the report's Stories table lists the unreached Q2 as 'not reached'"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(E2) the run wrote 'finished'"

echo
echo "== (E3) with a large cap the same 20-minute-old reset resolves to TOMORROW =="
setup E3 'QUOTA_MARGIN_SEC="5"' 'QUOTA_MAX_WAIT_SEC="172800"'
nr_queue "$ND" T1 T2
nr_plan "$ND/fake" "past:20" "ok" "ok"
dl=$(date -d '+3 minutes' +%H:%M)
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" --deadline "$dl" >"$ROOT/E3/out.txt" 2>&1; rcE3=$?
tE3=$(( $(date +%s) - t0 ))
printf 'run E3 finished in %ss with exit %s (deadline %s)\n' "$tE3" "$rcE3" "$dl"
hhmm=$(cat "$ND/fake/last-reset-hhmm" 2>/dev/null)
# The same rule, computed independently of the runner: that time TODAY, or
# tomorrow when today's is already past. (Between 00:00 and 00:20 UTC "20
# minutes ago" is still ahead of us today — the epoch is ~23h40m out either
# way, which is what "tomorrow's reset" means here.)
exp=$(date -d "TZ=\"UTC\" $hhmm" +%s 2>/dev/null || echo 0)
[ "$exp" -le "$t0" ] && exp=$(date -d "TZ=\"UTC\" tomorrow $hhmm" +%s 2>/dev/null || echo 0)
expiso=$(date -u -d "@$exp" +%FT%TZ 2>/dev/null)
r=$(row T1 DEFERRED-quota); got=${r##*resets=}
printf 'announced %s -> expected %s, recorded %s (%sh out)\n' "$hhmm" "$expiso" "$got" "$(( (exp - t0) / 3600 ))"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(E3) T1 got a DEFERRED-quota row"
check "$([ -n "$expiso" ] && [ "$got" = "$expiso" ] && echo 0 || echo 1)" "(E3) the reset resolved to the next occurrence of $hhmm"
check "$([ "$(( exp - t0 ))" -gt 82800 ] && echo 0 || echo 1)" "(E3) …which is a full day out, not 'now'"
check "$([ "$tE3" -le 60 ] && echo 0 || echo 1)" "(E3) the run did not take that wait (${tE3}s) — the deadline barred it"
check "$(grep -q 'QUOTA-WAIT refused' "$LOG" && echo 0 || echo 1)" "(E3) it logged the refusal"

# ============================== (F) the limit message is not always the last =
echo
echo "== (F) a limit message followed by 20 more lines is still a quota stop =="
setup F1 'QUOTA_MARGIN_SEC="5"' 'QUOTA_MAX_WAIT_SEC="1"'
nr_queue "$ND" N1
nr_plan "$ND/fake" "limitnoise:20" "ok"
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/F1/out.txt" 2>&1
lines=$(wc -l <"$ND/logs/N1.log" 2>/dev/null)
printf 'N1 log has %s lines; row: %s\n' "${lines:-0}" "$(awk '$1=="N1"' "$ND"/state-*.txt 2>/dev/null | tail -1)"
check "$([ -n "$(row N1 DEFERRED-quota)" ] && echo 0 || echo 1)" \
      "(F) the message 20 lines from the end was still classified DEFERRED-quota"

echo
echo "== (F) the same message with exit code 0 is NOT a quota row =="
setup F2 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" N2
nr_plan "$ND/fake" "limitok" "ok"
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/F2/out.txt" 2>&1
printf 'N2 row: %s\n' "$(awk '$1=="N2"' "$ND"/state-*.txt 2>/dev/null | tail -1)"
check "$([ -n "$(row N2 0)" ] && echo 0 || echo 1)" "(F) a session that exited 0 got its numeric row"
check "$(grep -qE '^N2 DEFERRED' "$ND"/state-*.txt 2>/dev/null && echo 1 || echo 0)" "(F) …and no quota row at all"

# ============================= (G) a zone whose LOCAL DAY has already rolled =
# `date -d 'TZ="<zone>" <time>'` resolves a bare time against the current day OF
# THAT ZONE. Minutes after the zone crosses midnight, the reset it announced
# belongs to the day BEFORE — and the day-blind parse lands almost 24 h ahead.
# Measured in production: `resets 11:56pm (Etc/GMT+12)` came out +1414 min.
#
# The zone below is a POSIX offset spec, not an IANA name, for one reason: real
# zones only come in :00, :30 and :45 offsets, so for a quarter of every hour no
# IANA name is inside its own first 15 minutes — and this case must be
# reproducible at ANY wall-clock time. run.sh hands whatever stands in the
# parentheses straight to `date -d 'TZ="…" …'`, so the code path is identical.
echo
echo "== (G) a reset in a zone that is minutes past ITS OWN midnight is not a day out =="
setup G 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" G1 G2
g_now=$(date +%s)
# The offset that makes the announcing zone read 00:09 local right now, so the
# announced 11:57pm is 12 minutes ago — inside QUOTA_PAST_GRACE_SEC — but on the
# zone's PREVIOUS day.
g_off=$(( ( 540 - g_now % 86400 + 86400 ) % 86400 ))
ZONE=$(printf 'NRT-%d:%02d:%02d' $(( g_off / 3600 )) $(( g_off % 3600 / 60 )) $(( g_off % 60 )))
g_naive=$(date -d "TZ=\"$ZONE\" 11:57pm" +%s)
g_true=$(date -d "TZ=\"$ZONE\" yesterday 11:57pm" +%s)
printf 'zone %s reads %s local; "resets 11:57pm" there was %s min ago, but the day-blind parse gives %s min AHEAD\n' \
  "$ZONE" "$(TZ=$ZONE date +%T)" "$(( (g_now - g_true) / 60 ))" "$(( (g_naive - g_now) / 60 ))"
nr_plan "$ND/fake" "raw:You've hit your session limit · resets 11:57pm ($ZONE)" "ok" "ok" "ok"
dl=$(date -d '+10 minutes' +%H:%M)
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" --deadline "$dl" >"$ROOT/G/out.txt" 2>&1; rcG=$?
tG=$(( $(date +%s) - t0 ))
r=$(row G1 DEFERRED-quota); got=${r##*resets=}
gote=$(date -u -d "$got" +%s 2>/dev/null || echo 0)
printf 'run G finished in %ss with exit %s; G1 row: %s\n  recorded reset is %ss from the start (the day-blind answer was %s min)\n' \
  "$tG" "$rcG" "${r:-<none>}" "$(( gote - t0 ))" "$(( (g_naive - t0) / 60 ))"
check "$([ -n "$r" ] && echo 0 || echo 1)" "(G) G1 got a DEFERRED-quota row"
check "$([ "$gote" -gt 0 ] && [ "$(( gote - t0 ))" -lt 300 ] && echo 0 || echo 1)" \
      "(G) the reset was treated as NOW ($(( gote - t0 ))s out), not the day-blind $(( (g_naive - t0) / 60 )) min"
check "$([ "$tG" -le 90 ] && echo 0 || echo 1)" "(G) the whole run took ${tG}s — the wait was the margin only"
check "$([ -n "$(row G1 0)" ] && echo 0 || echo 1)" "(G) G1 ran and completed after that margin"
check "$([ -n "$(row G2 0)" ] && echo 0 || echo 1)" "(G) G2 ran and completed"

echo
echo "== (G) an ordinary '(UTC)' reset three hours ahead is untouched by that rule =="
setup G3 'QUOTA_MARGIN_SEC="5"' 'QUOTA_MAX_WAIT_SEC="60"'
nr_queue "$ND" U1 U2
u_e=$(( ( $(date +%s) + 10800 ) / 60 * 60 ))
u_t=$(date -u -d "@$u_e" '+%-I:%M%P')
nr_plan "$ND/fake" "raw:You've hit your session limit · resets $u_t (UTC)" "ok"
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/G3/out.txt" 2>&1
tU=$(( $(date +%s) - t0 ))
r=$(row U1 DEFERRED-quota); got=${r##*resets=}; want=$(date -u -d "@$u_e" +%FT%TZ)
printf 'announced "resets %s (UTC)" (3 h out) -> expected %s, recorded %s; run took %ss\n' "$u_t" "$want" "${got:-<none>}" "$tU"
check "$([ -n "$r" ] && [ "$got" = "$want" ] && echo 0 || echo 1)" "(G) the 3 h reset still resolved to today, exactly $want"
check "$([ "$tU" -le 60 ] && echo 0 || echo 1)" "(G) …and QUOTA_MAX_WAIT_SEC=60 ended the run in ${tU}s"

# ================== (H) the report NEVER waits for a quota window ============
echo
echo "== (H) the walk ended for its OWN reason with quota-until armed: no wait in the report =="
setup H 'QUOTA_MARGIN_SEC="5"'
nr_queue "$ND" K1 K2
nr_plan "$ND/fake" "ok" "ok"
# The owner's kill switch ends the walk before the first story while a quota
# window from an earlier pass is still armed an hour out. QUOTA_MAX_WAIT_SEC is
# left at its 6 h default ON PURPOSE: nothing but write_report's own rule can
# keep the runner from sitting on run.flock for that hour with nothing running.
printf 'owner asked for a stop\n' >"$ND/STOP"
qe=$(( $(date +%s) + 3600 ))
printf '%s\n' "$qe" >"$ND/quota-until"
t0=$(date +%s)
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/H/out.txt" 2>&1; rcH=$?
tH=$(( $(date +%s) - t0 ))
printf 'run H finished in %ss with exit %s; quota-until was %s (%s min ahead)\n' \
  "$tH" "$rcH" "$(date -u -d "@$qe" +%FT%TZ)" "$(( (qe - t0) / 60 ))"
check "$([ "$tH" -le 30 ] && echo 0 || echo 1)" "(H) the run ended in ${tH}s instead of holding the lock for 60 min"
check "$(grep -q 'REPORT narrative skipped — quota resets at' "$LOG" && echo 0 || echo 1)" \
      "(H) the runner logged the skip and named the reset"
rep=$(report)
check "$([ -n "$rep" ] && grep -q '^## Counts' "$rep" && echo 0 || echo 1)" "(H) the deterministic report is there"
check "$([ -n "$rep" ] && grep -q '^## Narrative' "$rep" && echo 1 || echo 0)" "(H) …and it has no '## Narrative' section"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(H) 'finished' was written"
lockrc=$(flock -n "$ND/run.flock" true >/dev/null 2>&1; echo $?)
printf 'flock -n on run.flock after the run: rc=%s\n' "$lockrc"
check "$([ "$lockrc" -eq 0 ] && echo 0 || echo 1)" "(H) run.flock is free again (flock -n rc=$lockrc)"

# ============== (I) the kill switch is seen DURING a wait, not a minute later =
echo
echo "== (I) a STOP dropped mid-wait aborts it within seconds, not within a sleep slice =="
setup I 'QUOTA_MARGIN_SEC="5"' 'QUOTA_MAX_WAIT_SEC="600"'
nr_queue "$ND" C1 C2
# A reset ~2 minutes out: long enough that a 60 s sleep slice would hide the
# owner's kill switch for most of a minute.
nr_plan "$ND/fake" "limit:120" "ok" "ok"
setsid -w bash "$NR_RUN" --config "$CFG" >"$ROOT/I/out.txt" 2>&1 &
irunner=$!
waited=0
while [ "$waited" -lt 600 ]; do
  grep -q 'QUOTA-WAIT until' "$LOG" 2>/dev/null && break
  sleep 0.05; waited=$((waited + 1))
done
check "$(grep -q 'QUOTA-WAIT until' "$LOG" && echo 0 || echo 1)" "(I) the runner entered the quota wait"
# Two seconds INTO a slice, so what is measured is the slice and not a lucky
# boundary right after the runner looked.
sleep 2
s0=$(date +%s%N)
printf 'owner asked for a stop mid-wait\n' >"$ND/STOP"
waited=0
while [ "$waited" -lt 300 ]; do
  grep -q 'QUOTA-WAIT aborted' "$LOG" 2>/dev/null && break
  sleep 0.05; waited=$((waited + 1))
done
lat=$(( ( $(date +%s%N) - s0 ) / 1000000 ))
wait "$irunner" 2>/dev/null; rcI=$?
printf 'STOP dropped mid-wait; the runner noticed it %s ms later and exited %s\n' "$lat" "$rcI"
check "$(grep -q 'QUOTA-WAIT aborted — the STOP file appeared' "$LOG" && echo 0 || echo 1)" "(I) the wait was aborted by the STOP"
check "$([ "$lat" -le 10000 ] && echo 0 || echo 1)" "(I) …${lat} ms after it appeared, well inside 10 s"
check "$([ -n "$(report)" ] && echo 0 || echo 1)" "(I) the run still wrote its report"
check "$([ -s "$ND/finished" ] && echo 0 || echo 1)" "(I) …and 'finished'"

# ------------------------------------------------------------------ strays ---
echo
nr_cleanup "$ROOT"/*/nd
strays=$(nr_strays)
[ -n "$strays" ] && printf 'stray processes still on the scratch path:\n%s' "$strays"
check "$([ -z "$strays" ] && echo 0 || echo 1)" "no processes left behind under $NR_SCRATCH"

nr_summary "quota"
