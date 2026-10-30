#!/usr/bin/env bash
# Parity test: hooks/lib-saver-level.sh (saver_resolve -> SAVER_LEVEL) against the SHARED case
# table hooks/tests/saver-level-cases.json. The node port (hooks/node/lib/saver-level.js) runs
# the same table in hooks/node/tests/saver-level.test.js, so the two cannot drift.
# node is used ONLY to read the table (base64 fields, '|' separated, "-" = null).
# Everything lives under one mktemp -d, removed on exit.

set -uo pipefail
unset ANTHROPIC_BASE_URL CC_WORKER_MODE BAJZI_SESSION_LEVEL CLAUDE_PROJECT_DIR CC_ROUTER_WORKER BAJZI_HOME BAJZI_STATUS_DIR CLAUDE_CODE_SESSION_ID

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
    console.log([c.name, b(c.base_url), b(c.worker_mode_env), b(c.worker_mode_file), c.expect_word, b(c.repo_file === undefined ? null : c.repo_file), c.no_cwd ? "1" : "0", b(c.sub_file === undefined ? null : c.sub_file)].join("|"));
  }
});' < "$CASES")

[ -n "$rows" ] || { echo "FAIL - no rows read from $CASES"; exit 1; }

dec() { printf '%s' "${1#b:}" | base64 -d; }

while IFS='|' read -r name url envm file expect repo nocwd sub; do
    [ -z "$name" ] && continue
    unset ANTHROPIC_BASE_URL CC_WORKER_MODE CLAUDE_PROJECT_DIR
    home="$TMP/$name"
    mkdir -p "$home/.claude" "$home/cwd"
    [ "$url" != "-" ] && export ANTHROPIC_BASE_URL="$(dec "$url")"
    [ "$envm" != "-" ] && export CC_WORKER_MODE="$(dec "$envm")"
    [ "$file" != "-" ] && dec "$file" > "$home/.claude/worker-mode"
    [ "$repo" != "-" ] && { mkdir -p "$home/cwd/runtime"; dec "$repo" > "$home/cwd/runtime/worker-mode"; }
    cwdarg="$home/cwd"; [ "$nocwd" = "1" ] && cwdarg=""
    if [ "$sub" != "-" ]; then   # project root set, hook cwd = a subfolder with its own runtime/worker-mode: the root file wins
        mkdir -p "$home/cwd/sub/runtime"; dec "$sub" > "$home/cwd/sub/runtime/worker-mode"
        export CLAUDE_PROJECT_DIR="$home/cwd"; cwdarg="$home/cwd/sub"
    fi
    HOME="$home" saver_resolve "$cwdarg"
    if [ "$SAVER_LEVEL" = "$expect" ]; then
        pass "parity $name -> $expect"
    else
        fail "parity $name" "want '$expect', bash gave '$SAVER_LEVEL'"
    fi
done <<< "$rows"
unset CLAUDE_PROJECT_DIR

# --- per-session level (spec §6.1): <status dir>/<session_id>.level, between CC_WORKER_MODE and
# worker-mode. These cases are not in the shared table: each runs BOTH resolvers on the same
# fixture (bash saver_resolve <cwd> <id>, node resolveLevel({sessionId})) and both must give
# the expected word. Fields: name | ANTHROPIC_BASE_URL | CC_WORKER_MODE | worker-mode body |
# session file name (under <home>/.claude/bajzi/sessions) | its body | session id passed | expect |
# BAJZI_SESSION_LEVEL | <cwd>/runtime/worker-mode body (repo default).
# "-" = unset / no file; bodies go through printf %b.
node_level() { # $1 = home, $2 = session id -> the node resolver's word
    (cd "$HOOKS_DIR/node" && LVL_HOME="$1" LVL_SID="$2" LVL_CWD="$1/cwd" node -e '
const { resolveLevel } = require("./lib/saver-level");
process.stdout.write(resolveLevel({ env: process.env, home: process.env.LVL_HOME, sessionId: process.env.LVL_SID, cwd: process.env.LVL_CWD }).word);')
}
X128=$(printf 'x%.0s' $(seq 1 128))
while IFS='|' read -r name url envm wm sfile sbody sid expect inh repo; do
    [ -z "$name" ] && continue
    unset ANTHROPIC_BASE_URL CC_WORKER_MODE BAJZI_SESSION_LEVEL
    [ -n "$inh" ] && export BAJZI_SESSION_LEVEL="$inh"
    home="$TMP/s-$name"
    sdir="$home/.claude/bajzi/sessions"
    mkdir -p "$sdir" "$home/cwd"
    [ "$url" != "-" ] && export ANTHROPIC_BASE_URL="$url"
    [ "$envm" != "-" ] && export CC_WORKER_MODE="$envm"
    [ "$wm" != "-" ] && printf '%b' "$wm" > "$home/.claude/worker-mode"
    sfile="${sfile//X128/$X128}"; sid="${sid//X128/$X128}"
    [ "$sfile" != "-" ] && printf '%b' "$sbody" > "$sdir/$sfile"
    [ "$sid" = "-" ] && sid=""
    [ -n "$repo" ] && { mkdir -p "$home/cwd/runtime"; printf '%b' "$repo" > "$home/cwd/runtime/worker-mode"; }
    HOME="$home" saver_resolve "$home/cwd" "$sid"
    nw=$(node_level "$home" "$sid")
    if [ "$SAVER_LEVEL" = "$expect" ] && [ "$nw" = "$expect" ]; then
        pass "session $name -> $expect (bash = node)"
    else
        fail "session $name" "want '$expect', bash gave '$SAVER_LEVEL', node gave '$nw'"
    fi
done <<'ROWS'
present-wins|-|-|glm\n|A.level|tight\n|A|tight
other-session-keeps-default|-|-|glm\n|A.level|tight\n|B|glm
no-session-id|-|-|glm\n|A.level|tight\n|-|glm
empty-falls-through|-|-|glm\n|A.level||A|glm
blank-first-line-falls-through|-|-| light\n|A.level| \r\ntight\n|A|light
no-machine-default|-|-|-|A.level|light\n|A|light
bom-crlf-case|-|-|glm\n|A.level|\xef\xbb\xbf Light\r\n|A|light
unknown-word-wins|-|-|glm\n|A.level|turbo\n|A|turbo
unsafe-dotdot|-|-|glm\n|../x.level|tight\n|../x|glm
unsafe-slash|-|-|glm\n|A.level|tight\n|A/|glm
unsafe-space|-|-|glm\n|A.level|tight\n|A |glm
repo-loses-to-session-file|-|-|-|A.level|tight\n|A|tight||light\n
repo-loses-to-inherited|-|-|-|-|-|B|light|light|tight\n
unsafe-dot|-|-|glm\n|A.level|tight\n|.|glm
id-128-ok|-|-|glm\n|X128.level|tight\n|X128|tight
id-129-unsafe|-|-|glm\n|X128x.level|tight\n|X128x|glm
env-overrides-session|-|light|glm\n|A.level|tight\n|A|light
zai-forces-tight|https://api.z.ai/api/anthropic|-|glm\n|A.level|claude\n|A|tight
inherited-alone|-|-|glm\n|-|-|B|light| Light
inherited-own-file-wins|-|-|glm\n|A.level|tight\n|A|tight|light
inherited-env-wins|-|tight|glm\n|-|-|A|tight|light
inherited-unknown-word|-|-|glm\n|-|-|B|turbo|turbo
ROWS
unset ANTHROPIC_BASE_URL CC_WORKER_MODE BAJZI_SESSION_LEVEL

TOTAL=$((PASS + FAIL))
echo "PASS $PASS/$TOTAL"
[ "$FAIL" -eq 0 ] && [ "$TOTAL" -gt 0 ]
