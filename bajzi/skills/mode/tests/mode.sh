#!/usr/bin/env bash
# Black-box tests for the bajzi:mode skill (SKILL.md) and the SessionStart
# hook bajzi/hooks/day-run-mode.sh. Read-only against those files: this
# script never edits SKILL.md, DAY-RUN-RULES.md, hooks.json or the hook.
#
# Cases 1-3 pull the documented write sequence and read command verbatim out
# of SKILL.md with sed/grep and execute those exact strings against a temp
# fixture, so this test fails if SKILL.md's snippet drifts from the hook's.
# Cases 4-10 run the real hook script against a fake plugin root.
#
# The real `claude` CLI is never invoked: PATH is prefixed with a shim that
# exits 99 and drops a marker file; case 8 checks the marker never appeared.
#
# Everything lives under one mktemp -d, removed on exit by the trap.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BAJZI_DIR="$(cd "$MODE_DIR/../.." && pwd)"
SKILL_MD="$MODE_DIR/SKILL.md"
RULES_MD="$MODE_DIR/DAY-RUN-RULES.md"
SAVER_MD="$MODE_DIR/SAVER-RULES.md"
HOOK_SH="$BAJZI_DIR/hooks/day-run-mode.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_HOME="$TMP/home"
FAKE_CWD="$TMP/cwd"
FAKE_ROOT="$TMP/plugin-root"
ALT_ROOT="$TMP/plugin-root-norules"
NOSAVER_ROOT="$TMP/plugin-root-nosaver"
SHIM_DIR="$TMP/shim"
MARKER="$TMP/claude-was-invoked"

mkdir -p "$FAKE_HOME/.claude" "$FAKE_CWD/runtime" "$FAKE_ROOT/skills/mode" \
    "$ALT_ROOT/skills/mode" "$NOSAVER_ROOT/skills/mode" "$SHIM_DIR"
ln -s "$RULES_MD" "$FAKE_ROOT/skills/mode/DAY-RUN-RULES.md"
ln -s "$SAVER_MD" "$FAKE_ROOT/skills/mode/SAVER-RULES.md"
# day-run rules only -- no SAVER-RULES.md, for case 10f
ln -s "$RULES_MD" "$NOSAVER_ROOT/skills/mode/DAY-RUN-RULES.md"

cat > "$SHIM_DIR/claude" <<SHIM
#!/usr/bin/env bash
touch "$MARKER"
exit 99
SHIM
chmod +x "$SHIM_DIR/claude"
export PATH="$SHIM_DIR:$PATH"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL - %s -- %s\n' "$1" "${2:-}"; }

# JSON validation, stdin = the candidate document. Uses whatever interpreter the
# machine has; with none of them present it cannot assert and reports success.
JSON_CHECK=""
for c in python python3 node; do
    command -v "$c" >/dev/null 2>&1 && JSON_CHECK="$c" && break
done
json_ok() {
    case "$JSON_CHECK" in
        python | python3) "$JSON_CHECK" -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 ;;
        node) node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s))' \
            >/dev/null 2>&1 ;;
        *) cat >/dev/null; return 0 ;;
    esac
}

# --- extraction: SKILL.md's documented write sequence and read command ---

extract_write_block() {
    local fence_lines=() i=0 start end candidate
    while IFS= read -r n; do fence_lines+=("$n"); done \
        < <(grep -n '^```$' "$SKILL_MD" | cut -d: -f1)
    while [ "$i" -lt "${#fence_lines[@]}" ]; do
        start="${fence_lines[$i]}"
        end="${fence_lines[$((i + 1))]:-}"
        [ -z "$end" ] && break
        candidate="$(sed -n "$((start + 1)),$((end - 1))p" "$SKILL_MD")"
        if printf '%s' "$candidate" | grep -q 'mkdir -p'; then
            printf '%s' "$candidate"
            return 0
        fi
        i=$((i + 2))
    done
    return 1
}

extract_read_cmd() {
    grep -n '^`head -1 "<file>"' "$SKILL_MD" | head -1 | cut -d: -f2- \
        | sed -e 's/^`//' -e 's/`$//'
}

run_write() { # $1 = target dir, $2 = mode word
    local block
    block="$(extract_write_block)" || return 1
    block="${block//<dir>/$1}"
    block="${block//<mode>/$2}"
    bash -c "$block"
}

read_mode() { # $1 = file path -> prints the resolved mode word
    local cmd
    cmd="$(extract_read_cmd)"
    cmd="${cmd//<file>/$1}"
    eval "$cmd"
}

# --- cases 1-2: documented write sequence, target $HOME/.claude ---

run_write "$FAKE_HOME/.claude" "day-run"
exp="$TMP/expected"
printf '%s\n' "day-run" > "$exp"
if cmp -s "$exp" "$FAKE_HOME/.claude/bajzi-mode"; then
    pass "1 day-run write: file is exactly 'day-run\\n'"
else
    fail "1 day-run write" "content: $(cat "$FAKE_HOME/.claude/bajzi-mode" 2>/dev/null)"
fi

run_write "$FAKE_HOME/.claude" "normal"
printf '%s\n' "normal" > "$exp"
if cmp -s "$exp" "$FAKE_HOME/.claude/bajzi-mode"; then
    pass "2 normal write: overwrites to exactly 'normal\\n'"
else
    fail "2 normal write" "content: $(cat "$FAKE_HOME/.claude/bajzi-mode" 2>/dev/null)"
fi
shopt -s nullglob
strays=("$FAKE_HOME/.claude"/.bajzi-mode.*)
shopt -u nullglob
if [ "${#strays[@]}" -eq 0 ]; then
    pass "2 normal write: no stray .bajzi-mode.* temp file"
else
    fail "2 normal write: stray temp file left behind" "${strays[*]}"
fi

# --- case 3: resolution order (project file wins) + the documented read ---

printf '%s\n' "day-run" > "$FAKE_CWD/runtime/bajzi-mode"
printf '%s\n' "normal" > "$FAKE_HOME/.claude/bajzi-mode"
if [ -s "$FAKE_CWD/runtime/bajzi-mode" ]; then
    src="runtime/bajzi-mode"; f="$FAKE_CWD/runtime/bajzi-mode"
else
    src="~/.claude/bajzi-mode"; f="$FAKE_HOME/.claude/bajzi-mode"
fi
mode="$(read_mode "$f")"
if [ "$mode" = "day-run" ] && [ "$src" = "runtime/bajzi-mode" ]; then
    pass "3 status: project file wins (day-run, runtime/bajzi-mode)"
else
    fail "3 status: project override" "mode=$mode src=$src"
fi

rm -f "$FAKE_CWD/runtime/bajzi-mode"
if [ -s "$FAKE_CWD/runtime/bajzi-mode" ] 2>/dev/null; then
    src="runtime/bajzi-mode"; f="$FAKE_CWD/runtime/bajzi-mode"
else
    src="~/.claude/bajzi-mode"; f="$FAKE_HOME/.claude/bajzi-mode"
fi
mode="$(read_mode "$f")"
if [ "$mode" = "normal" ] && [ "$src" = "~/.claude/bajzi-mode" ]; then
    pass "3 status: falls back to user file (normal, ~/.claude/bajzi-mode)"
else
    fail "3 status: fallback" "mode=$mode src=$src"
fi

# --- cases 4-9: the real hook ---

run_hook() { # $1 = cwd, $2 = home, $3 = plugin root
    printf '{"cwd":"%s"}' "$1" | CLAUDE_PLUGIN_ROOT="$3" HOME="$2" bash "$HOOK_SH"
}

rm -f "$FAKE_CWD/runtime/bajzi-mode"

# case 4: project override wins, both directions
printf '%s\n' "normal" > "$FAKE_CWD/runtime/bajzi-mode"
printf '%s\n' "day-run" > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
if [ "$out" = "{}" ]; then
    pass "4 project=normal over user=day-run -> {}"
else
    fail "4 project=normal over user=day-run" "$out"
fi

printf '%s\n' "day-run" > "$FAKE_CWD/runtime/bajzi-mode"
printf '%s\n' "normal" > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
if [ "$out" != "{}" ] && printf '%s' "$out" | grep -q 'DAY-RUN MODE'; then
    pass "4 project=day-run over user=normal -> block"
else
    fail "4 project=day-run over user=normal" "$out"
fi

# case 5: {} for normal/absent/empty/garbage; block only for day-run
rm -f "$FAKE_CWD/runtime/bajzi-mode"
for val in "normal" "garbage-word"; do
    printf '%s\n' "$val" > "$FAKE_HOME/.claude/bajzi-mode"
    out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
    if [ "$out" = "{}" ]; then
        pass "5 mode=$val -> {}"
    else
        fail "5 mode=$val" "$out"
    fi
done
: > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
if [ "$out" = "{}" ]; then
    pass "5 empty mode file -> {}"
else
    fail "5 empty mode file" "$out"
fi
rm -f "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
if [ "$out" = "{}" ]; then
    pass "5 absent mode file -> {}"
else
    fail "5 absent mode file" "$out"
fi
printf '%s\n' "day-run" > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
if [ "$out" != "{}" ] && printf '%s' "$out" | grep -q 'DAY-RUN MODE'; then
    pass "5 mode=day-run -> block (contrast case)"
else
    fail "5 mode=day-run" "$out"
fi

# case 6: whitespace/uppercase tolerance
printf '  DAY-RUN \n' > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
if [ "$out" != "{}" ] && printf '%s' "$out" | grep -q 'DAY-RUN MODE'; then
    pass "6 '  DAY-RUN <space>\\n' normalizes to day-run"
else
    fail "6 whitespace/uppercase tolerance" "$out"
fi

# case 7: output length caps
ac="$(printf '%s' "$out" | sed -n 's/.*"additionalContext":"\(.*\)"}}$/\1/p')"
nlines="$(printf '%s' "$ac" | grep -o '\\n' | wc -l)"
if [ "$nlines" -le 85 ]; then
    pass "7 additionalContext <= 85 lines ($nlines)"
else
    fail "7 additionalContext line count" "$nlines"
fi
rules_lines="$(grep -c '' "$RULES_MD")"
if [ "$rules_lines" -le 80 ]; then
    pass "7 DAY-RUN-RULES.md <= 80 lines ($rules_lines)"
else
    fail "7 DAY-RUN-RULES.md line count" "$rules_lines"
fi
# the hook's head cap must not silently truncate the rules file again
if printf '%s' "$out" | grep -q 'Day-run never merges\.'; then
    pass "7 last line of DAY-RUN-RULES.md survives the head cap"
else
    fail "7 rules file truncated by the head cap" "missing 'Day-run never merges.'"
fi
if printf '%s' "$out" | json_ok; then
    pass "7 day-run output is valid JSON"
else
    fail "7 day-run output is not valid JSON" "$out"
fi

# case 9: missing DAY-RUN-RULES.md emits {} rather than failing
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$ALT_ROOT")"
rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "{}" ]; then
    pass "9 missing DAY-RUN-RULES.md -> {} (exit 0)"
else
    fail "9 missing DAY-RUN-RULES.md" "rc=$rc out=$out"
fi

# --- case 10: saver mode (the GLM rung) ---
#
# Saver mode is driven by $HOME/.claude/worker-mode, written by the owner's
# `worker` wrapper. HOME is the fake one for every call below, so the real
# ~/.claude/worker-mode is never read or written. BAJZI_SAVER_LAUNCHER replaces
# the `glm` name in the hook's PATH probe: "bash" is a command that certainly
# exists, the xyz name is one that certainly does not.

run_hook_saver() { # $1 = cwd, $2 = home, $3 = plugin root, $4 = launcher name
    printf '{"cwd":"%s"}' "$1" \
        | CLAUDE_PLUGIN_ROOT="$3" HOME="$2" BAJZI_SAVER_LAUNCHER="$4" bash "$HOOK_SH"
}

WM="$FAKE_HOME/.claude/worker-mode"
rm -f "$FAKE_CWD/runtime/bajzi-mode"
printf '%s\n' "day-run" > "$FAKE_HOME/.claude/bajzi-mode"

printf '%s\n' "glm" > "$WM"
out="$(run_hook_saver "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "bash")"
if printf '%s' "$out" | grep -q 'SAVER LEVEL L2'; then
    pass "10a day-run + worker-mode=glm -> SAVER LEVEL L2"
else
    fail "10a day-run + worker-mode=glm" "no SAVER LEVEL L2 in additionalContext"
fi
if printf '%s' "$out" | grep -q 'model: glm -- saver mode'; then
    pass "10a saver block carries the glm dispatch line"
else
    fail "10a saver dispatch line missing" "no 'model: glm -- saver mode' line"
fi
if printf '%s' "$out" | grep -q 'saver mode ON (worker-mode=glm)'; then
    pass "10a systemMessage reports saver mode"
else
    fail "10a systemMessage" "$(printf '%s' "$out" | sed -n 's/.*"systemMessage":"\([^"]*\)".*/\1/p')"
fi
if printf '%s' "$out" | json_ok; then
    pass "10a saver output is valid JSON"
else
    fail "10a saver output is not valid JSON" "$out"
fi

printf '%s\n' "claude" > "$WM"
out="$(run_hook_saver "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "bash")"
if [ "$out" != "{}" ] && ! printf '%s' "$out" | grep -q 'SAVER LEVEL'; then
    pass "10b worker-mode=claude -> day-run block, no SAVER LEVEL"
else
    fail "10b worker-mode=claude" "$out"
fi

rm -f "$WM"
out="$(run_hook_saver "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "bash")"
if [ "$out" != "{}" ] && ! printf '%s' "$out" | grep -q 'SAVER LEVEL'; then
    pass "10c no worker-mode file -> day-run block, no SAVER LEVEL"
else
    fail "10c no worker-mode file" "$out"
fi

printf '%s\n' "glm" > "$WM"
out="$(run_hook_saver "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "definitely-not-a-command-xyz")"
if [ "$out" != "{}" ] && ! printf '%s' "$out" | grep -q 'SAVER LEVEL'; then
    pass "10d worker-mode=glm but launcher absent -> no SAVER LEVEL"
else
    fail "10d launcher absent" "$out"
fi

printf '%s\n' "normal" > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook_saver "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "bash")"
if [ "$out" = "{}" ]; then
    pass "10e mode=normal + worker-mode=glm -> {} (saver never fires alone)"
else
    fail "10e mode=normal + worker-mode=glm" "$out"
fi

# 10f: every saver condition true, but the plugin root has no SAVER-RULES.md.
# The day-run block must still be emitted, plain -- saver silently stays off.
printf '%s\n' "day-run" > "$FAKE_HOME/.claude/bajzi-mode"
printf '%s\n' "glm" > "$WM"
out="$(run_hook_saver "$FAKE_CWD" "$FAKE_HOME" "$NOSAVER_ROOT" "bash")"
if printf '%s' "$out" | json_ok; then
    pass "10f missing SAVER-RULES.md: output is valid JSON"
else
    fail "10f missing SAVER-RULES.md: invalid JSON" "$out"
fi
if printf '%s' "$out" | grep -q 'DAY-RUN MODE' \
    && ! printf '%s' "$out" | grep -q 'SAVER LEVEL'; then
    pass "10f missing SAVER-RULES.md -> day-run block, no SAVER LEVEL"
else
    fail "10f missing SAVER-RULES.md" "$out"
fi
if ! printf '%s' "$out" | grep -qi 'saver'; then
    pass "10f systemMessage is the plain day-run one"
else
    fail "10f systemMessage claims a saver level" \
        "$(printf '%s' "$out" | sed -n 's/.*"systemMessage":"\([^"]*\)".*/\1/p')"
fi
rm -f "$WM"

# case 8: the claude shim was never invoked -- checked last, so it covers
# every case above, not just the ones textually before it.
if [ ! -e "$MARKER" ]; then
    pass "8 claude shim never invoked"
else
    fail "8 claude shim was invoked" "marker present at $MARKER"
fi

TOTAL=$((PASS + FAIL))
echo "PASS $PASS/$TOTAL"
if [ "$FAIL" -eq 0 ]; then
    exit 0
else
    exit 1
fi
