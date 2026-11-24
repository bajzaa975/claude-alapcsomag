#!/usr/bin/env bash
# Proves run.sh stops the queue when a story's claude exits 127 within 10 s of its start
# (binary not found in the runner's PATH): one story attempted, a runner.log line, no second story.
# Usage:  bash tests/claude-bin.sh
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

T=$NR_SCRATCH/claude-bin
rm -rf "$T"; mkdir -p "$T"
ND=$T/night; BASE=$T/base; CFG=$T/config.env
nr_make_base "$BASE"; nr_make_night "$ND"; nr_queue "$ND" S1 S2
nr_config "$CFG" "$ND" "$BASE" "$T/no-such-claude"
setsid -w bash "$NR_RUN" --config "$CFG" >"$T/out.txt" 2>&1; rc=$?
LOG=$ND/logs/runner.log
check "$(grep -qF 'CLAUDE_BIN not found (rc=127)' "$LOG" 2>/dev/null; echo $?)" "runner.log has the CLAUDE_BIN not found line (rc=$rc)"
check "$([ "$(grep -c ' START ' "$LOG" 2>/dev/null)" -eq 1 ]; echo $?)" "exactly one story attempted"
check "$(grep -q ' START S2' "$LOG" 2>/dev/null; [ $? -ne 0 ]; echo $?)" "S2 never started"
check "$(grep -q 'REPORT' "$LOG" 2>/dev/null; echo $?)" "the report step still ran"
nr_cleanup "$ND"
nr_summary claude-bin.sh
