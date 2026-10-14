#!/usr/bin/env bash
# bajzi noise filter — RUNNER (the part that actually executes the command).
#
# Invoked only via noise-filter.sh, which rewrites a noisy command into:
#   bash "<plugin>/hooks/noise-run.sh" '<original command>'
#
# Contract:
#   * the original command runs UNTOUCHED (same shell, same cwd, same env)
#   * its EXIT CODE is preserved — this is why we do not pipe into `tail`,
#     which would replace the exit status with tail's own
#   * stdout+stderr are captured in full to a log file, and only a compacted
#     view is printed, so only that view enters the model's context
#   * on failure we keep MORE, never less
#   * the full log path is always printed, so it can be grepped if needed
#
# Tunables (env):
#   BAJZI_NOISE_KEEP   under this many lines nothing is filtered (default 40)
#   BAJZI_NOISE_OFF=1  disable filtering entirely (pass-through)

set -uo pipefail

cmd="${1:-}"
if [ -z "$cmd" ]; then
  echo "noise-run.sh: no command given" >&2
  exit 2
fi

if [ "${BAJZI_NOISE_OFF:-0}" = "1" ]; then
  bash -c "$cmd"
  exit $?
fi

log_dir="${TMPDIR:-/tmp}/bajzi-noise"
mkdir -p "$log_dir" 2>/dev/null || log_dir="${TMPDIR:-/tmp}"
log="$log_dir/$(date +%Y%m%d-%H%M%S)-$$.log"

# Run it. No pipe -> $? is the real exit code of the user's command.
bash -c "$cmd" >"$log" 2>&1
rc=$?

clean="$log.clean"
# Progress bars overwrite one line with \r; turn those into real lines, then
# drop the pure-noise ones (spinner frames, percent-only, [====>   ], dots).
tr '\r' '\n' <"$log" \
  | grep -vE '^[[:space:]]*$|^[[:space:]]*[-\\|/][[:space:]]*$|^[[:space:]]*[0-9]{1,3}%[[:space:]]*$|\[[=#.]*>?[[:space:].]*\][[:space:]]*$|^[[:space:]]*[.#]+[[:space:]]*$' \
  >"$clean" 2>/dev/null || true

total=$(wc -l <"$clean" 2>/dev/null | tr -d ' ')
total=${total:-0}
keep=${BAJZI_NOISE_KEEP:-40}

# Short output: the user asked for the whole thing. Nothing to gain here.
if [ "$total" -le "$keep" ]; then
  cat "$clean"
  rm -f "$clean"
  exit $rc
fi

if [ "$rc" -ne 0 ]; then
  head_n=8; tail_n=40; err_cap=80
  err_re='error|fail|fatal|cannot|unable|denied|refused|traceback|exception|not found|missing|conflict|ERR!|^E[0-9]+|warning'
else
  head_n=5; tail_n=25; err_cap=40
  err_re='error|fail|fatal|cannot|denied|refused|traceback|exception|ERR!|vulnerabilit'
fi

echo "=== bajzi noise-filter: $total lines compacted, exit code $rc ==="
echo "--- first $head_n ---"
head -n "$head_n" "$clean"

errs=$(grep -niE "$err_re" "$clean" 2>/dev/null | head -n "$err_cap")
if [ -n "$errs" ]; then
  n=$(printf '%s\n' "$errs" | wc -l | tr -d ' ')
  echo "--- error/failure lines ($n shown, line-numbered) ---"
  printf '%s\n' "$errs"
fi

echo "--- last $tail_n (final summary) ---"
tail -n "$tail_n" "$clean"
echo "=== full log: $log — grep it if you need more ==="

rm -f "$clean"
exit $rc
