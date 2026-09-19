#!/usr/bin/env bash
# Black-box tests for the bajzi:mode skill (SKILL.md) and the SessionStart
# hook bajzi/hooks/day-run-mode.sh. Read-only against those files: this
# script never edits SKILL.md, DAY-RUN-RULES.md, hooks.json or the hook.
#
# Cases 1-3 pull the documented write sequence and read command verbatim out
# of SKILL.md with sed/grep and execute those exact strings against a temp
# fixture, so this test fails if SKILL.md's snippet drifts from the hook's.
# Cases 4-9 run the real hook script against a fake plugin root.
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
HOOK_SH="$BAJZI_DIR/hooks/day-run-mode.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_HOME="$TMP/home"
FAKE_CWD="$TMP/cwd"
FAKE_ROOT="$TMP/plugin-root"
ALT_ROOT="$TMP/plugin-root-norules"
SHIM_DIR="$TMP/shim"
MARKER="$TMP/claude-was-invoked"

mkdir -p "$FAKE_HOME/.claude" "$FAKE_CWD/runtime" "$FAKE_ROOT/skills/mode" \
    "$ALT_ROOT/skills/mode" "$SHIM_DIR"
ln -s "$RULES_MD" "$FAKE_ROOT/skills/mode/DAY-RUN-RULES.md"

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
if [ "$nlines" -le 45 ]; then
    pass "7 additionalContext <= 45 lines ($nlines)"
else
    fail "7 additionalContext line count" "$nlines"
fi
rules_lines="$(grep -c '' "$RULES_MD")"
if [ "$rules_lines" -le 40 ]; then
    pass "7 DAY-RUN-RULES.md <= 40 lines ($rules_lines)"
else
    fail "7 DAY-RUN-RULES.md line count" "$rules_lines"
fi

# case 9: missing DAY-RUN-RULES.md emits {} rather than failing
out="$(run_hook "$FAKE_CWD" "$FAKE_HOME" "$ALT_ROOT")"
rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "{}" ]; then
    pass "9 missing DAY-RUN-RULES.md -> {} (exit 0)"
else
    fail "9 missing DAY-RUN-RULES.md" "rc=$rc out=$out"
fi

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
