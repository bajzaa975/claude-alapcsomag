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

# Slow branch-lock release (12 s) must not push the 127 out of the 10 s window.
T2=$T/slow; ND=$T2/night; BASE=$T2/base; CFG=$T2/config.env
mkdir -p "$T2"; git init -q --bare -b main "$T2/origin.git"; git init -q -b main "$T2/seed"; printf x >"$T2/seed/f"
git -C "$T2/seed" add f; git -C "$T2/seed" -c user.name=t -c user.email=t@example.invalid commit -q -m i; git -C "$T2/seed" push -q "$T2/origin.git" main
git clone -q "$T2/origin.git" "$BASE"; mkdir -p "$BASE/.claude"; printf '{ "permissions": { "allow": [] } }\n' >"$BASE/.claude/settings.local.json"
 nr_make_night "$ND"; nr_queue "$ND" S1 S2
printf '#!/usr/bin/env bash\n[ "${1:-}" = release ] && sleep 12\nexit 0\n' >"$T2/lockcmd"; chmod 0755 "$T2/lockcmd"
nr_config "$CFG" "$ND" "$BASE" "$T2/no-such-claude" "BRANCH_LOCK_CMD=\"$T2/lockcmd\""
setsid -w bash "$NR_RUN" --config "$CFG" >"$T2/out.txt" 2>&1
LOG=$ND/logs/runner.log
check "$(grep -qF 'CLAUDE_BIN not found (rc=127)' "$LOG" 2>/dev/null; echo $?)" "slow lock release: still stops on rc=127"
check "$([ "$(grep -c ' START ' "$LOG" 2>/dev/null)" -eq 1 ]; echo $?)" "slow lock release: exactly one story attempted"
nr_cleanup "$ND"
# A 127 after the 10 s window is a story failure, not a missing binary: the queue keeps running.
T3=$T/late; ND=$T3/night; BASE=$T3/base; CFG=$T3/config.env
mkdir -p "$T3"; nr_make_base "$BASE"; nr_make_night "$ND"; nr_queue "$ND" S1 S2
printf '#!/usr/bin/env bash\nsleep 12\nexit 127\n' >"$T3/slow-claude"; chmod 0755 "$T3/slow-claude"
nr_config "$CFG" "$ND" "$BASE" "$T3/slow-claude"
setsid -w bash "$NR_RUN" --config "$CFG" >"$T3/out.txt" 2>&1
LOG=$ND/logs/runner.log
check "$(grep -q ' START S2' "$LOG" 2>/dev/null; echo $?)" "late 127 (12 s): S2 still started"
check "$(grep -qF 'CLAUDE_BIN not found' "$LOG" 2>/dev/null; [ $? -ne 0 ]; echo $?)" "late 127 (12 s): no CLAUDE_BIN not found line"
nr_cleanup "$ND"
nr_summary claude-bin.sh
