#!/usr/bin/env bash
# Parity test: hooks/lib-saver-level.sh (saver_resolve -> SAVER_LEVEL) against the SHARED case
# table hooks/tests/saver-level-cases.json. The node port (hooks/node/lib/saver-level.js) runs
# the same table in hooks/node/tests/saver-level.test.js, so the two cannot drift.
# node is used ONLY to read the table (base64 fields, '|' separated, "-" = null).
# Everything lives under one mktemp -d, removed on exit.

set -uo pipefail
unset ANTHROPIC_BASE_URL CC_WORKER_MODE CC_ROUTER_WORKER

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CASES="$SCRIPT_DIR/saver-level-cases.json"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL - %s -- %s\n' "$1" "${2:-}"; }

command -v node >/dev/null 2>&1 || { echo "FAIL - node not on PATH (needed to read the case table)"; exit 1; }

# shellcheck source=../lib-saver-level.sh
. "$HOOKS_DIR/lib-saver-level.sh"

rows=$(node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const b = v => v === null ? "-" : "b:" + Buffer.from(v, "utf8").toString("base64");
  for (const c of JSON.parse(s).cases) {
    console.log([c.name, b(c.base_url), b(c.worker_mode_env), b(c.worker_mode_file), c.expect_word].join("|"));
  }
});' < "$CASES")

[ -n "$rows" ] || { echo "FAIL - no rows read from $CASES"; exit 1; }

dec() { printf '%s' "${1#b:}" | base64 -d; }

while IFS='|' read -r name url envm file expect; do
    [ -z "$name" ] && continue
    unset ANTHROPIC_BASE_URL CC_WORKER_MODE
    home="$TMP/$name"
    mkdir -p "$home/.claude" "$home/cwd"
    [ "$url" != "-" ] && export ANTHROPIC_BASE_URL="$(dec "$url")"
    [ "$envm" != "-" ] && export CC_WORKER_MODE="$(dec "$envm")"
    [ "$file" != "-" ] && dec "$file" > "$home/.claude/worker-mode"
    HOME="$home" saver_resolve "$home/cwd"
    if [ "$SAVER_LEVEL" = "$expect" ]; then
        pass "parity $name -> $expect"
    else
        fail "parity $name" "want '$expect', bash gave '$SAVER_LEVEL'"
    fi
done <<< "$rows"

TOTAL=$((PASS + FAIL))
echo "PASS $PASS/$TOTAL"
[ "$FAIL" -eq 0 ] && [ "$TOTAL" -gt 0 ]
