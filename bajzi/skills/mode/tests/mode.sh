#!/usr/bin/env bash
# Black-box tests for the bajzi:mode skill (SKILL.md) and the SessionStart
# hook bajzi/hooks/day-run-mode.sh. Read-only against those files: this
# script never edits SKILL.md, DAY-RUN-RULES.md, hooks.json or the hook.
#
# Cases 1-3 pull the documented write sequence and read command verbatim out
# of SKILL.md with sed/grep and execute those exact strings against a temp
# fixture, so this test fails if SKILL.md's snippet drifts from the hook's.
# Cases 4-11 run the real hook script against a fake plugin root; case 12 runs
# the PostToolUse routing counter (hooks/routing-counter.sh), case 13 the
# PreToolUse dispatch guard (hooks/dispatch-guard.sh).
#
# The real `claude` CLI is never invoked: PATH is prefixed with a shim that
# exits 99 and drops a marker file; case 8 checks the marker never appeared.
#
# Everything lives under one mktemp -d, removed on exit by the trap.

set -uo pipefail
unset ANTHROPIC_BASE_URL CC_WORKER_MODE CC_ROUTER_WORKER   # the test process may itself run in a GLM/night-run env

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
if printf '%s' "$out" | grep -q 'saver L2 (glm)'; then
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

# --- case 11: saver levels ---
#
# The level comes from CC_WORKER_MODE (runner), else $HOME/.claude/worker-mode;
# a z.ai provider (ANTHROPIC_BASE_URL) forces L3, or the GLM-worker block when
# CC_ROUTER_WORKER=1. run_hook_env scrubs all three and sets only what the case
# passes. Every output must also be valid JSON (the hook must never fail).
run_hook_env() { # $1 = cwd, $2 = home, $3 = plugin root, then KEY=VALUE pairs
    local c="$1" h="$2" r="$3"; shift 3
    printf '{"cwd":"%s"}' "$c" | env -u ANTHROPIC_BASE_URL -u CC_ROUTER_WORKER -u CC_WORKER_MODE \
        HOME="$h" CLAUDE_PLUGIN_ROOT="$r" BAJZI_SAVER_LAUNCHER=bash "$@" bash "$HOOK_SH"
}
for f in SAVER-L1.md SAVER-L3.md GLM-WORKER.md; do ln -sf "$MODE_DIR/$f" "$FAKE_ROOT/skills/mode/$f"; done
ZAI=ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
rm -f "$FAKE_CWD/runtime/bajzi-mode"
printf 'day-run\n' > "$FAKE_HOME/.claude/bajzi-mode"
expect() { # $1 name, $2 output, $3 must-contain, $4 must-not-contain (optional); also asserts valid JSON
    if printf '%s' "$2" | grep -q -- "$3" && { [ -z "${4:-}" ] || ! printf '%s' "$2" | grep -q -- "$4"; } \
        && printf '%s' "$2" | json_ok; then pass "$1"; else fail "$1" "$2"; fi
}
# expect_msg: the same must / must-not check on the systemMessage alone (not JSON, so no json_ok).
expect_msg() { # $1 name, $2 full hook output, $3 must-contain, $4 must-not-contain (optional)
    local m; m=$(printf '%s' "$2" | sed -n 's/.*"systemMessage":"\([^"]*\)".*/\1/p')
    if printf '%s' "$m" | grep -q -- "$3" && { [ -z "${4:-}" ] || ! printf '%s' "$m" | grep -q -- "$4"; }; then
        pass "$1"; else fail "$1" "$m"; fi
}
printf 'light\n' > "$FAKE_HOME/.claude/worker-mode"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
expect "11a file=light -> L1 block" "$out" 'SAVER LEVEL L1' 'SAVER LEVEL L2'
expect "11a day-run table kept alongside L1" "$out" 'ROUTING TABLE'
expect_msg "11a systemMessage names L1" "$out" 'saver L1 (light)'
printf 'glm\n' > "$FAKE_HOME/.claude/worker-mode"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
expect "11b file=glm -> L2 block" "$out" 'SAVER LEVEL L2' 'SAVER LEVEL L1'
expect "11c env beats file" "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" CC_WORKER_MODE=light)" 'SAVER LEVEL L1' 'SAVER LEVEL L2'
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" CC_WORKER_MODE=light "$ZAI")"
expect "11d z.ai provider beats level=light -> L3" "$out" 'SAVER LEVEL L3' 'SAVER LEVEL L1'
expect_msg "11d systemMessage names L3" "$out" 'saver L3 (tight)'
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$ZAI" CC_ROUTER_WORKER=1)"
expect "11e z.ai + CC_ROUTER_WORKER=1 -> GLM worker, no day-run table" "$out" 'GLM WORKER' 'ROUTING TABLE'
expect "11e worker gets no saver level block" "$out" 'GLM WORKER' 'SAVER LEVEL'
expect_msg "11e systemMessage names the GLM worker" "$out" 'GLM worker'
expect "11e' CC_ROUTER_WORKER=1 on Claude provider -> ignored, L2 as usual" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" CC_ROUTER_WORKER=1)" 'SAVER LEVEL L2' 'GLM WORKER'
expect "11e'' Claude session at tight -> L3 text" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" CC_WORKER_MODE=tight)" 'SAVER LEVEL L3' 'SAVER LEVEL L2'
printf 'banana\n' > "$FAKE_HOME/.claude/worker-mode"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
expect "11f garbage level on Claude -> no saver block + warning" "$out" 'treated as L0' 'SAVER LEVEL'
expect "11f day-run table still injected" "$out" 'ROUTING TABLE'
printf 'normal\n' > "$FAKE_HOME/.claude/bajzi-mode"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" CC_WORKER_MODE=tight)"
expect "11g day-run off but runner set CC_WORKER_MODE=tight -> L3 still injected" "$out" 'SAVER LEVEL L3' 'ROUTING TABLE'
expect_msg "11g systemMessage does not claim day-run" "$out" 'CC_WORKER_MODE' 'day-run mode active'
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
[ "$out" = "{}" ] && pass "11h day-run off, no env -> {} (bare install stays silent)" || fail "11h" "$out"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$ZAI")"
expect "11i day-run off, no env, z.ai provider -> L3 block, no day-run table" "$out" 'SAVER LEVEL L3' 'ROUTING TABLE'
expect_msg "11i systemMessage credits the non-Anthropic provider" "$out" 'non-Anthropic provider (api.z.ai)'
printf 'day-run\n' > "$FAKE_HOME/.claude/bajzi-mode"; rm -f "$FAKE_HOME/.claude/worker-mode"

# 11j: FAIL CLOSED. Non-Anthropic provider, day-run on, but no SAVER-L3.md /
# GLM-WORKER.md in the plugin root (NOSAVER_ROOT has DAY-RUN-RULES.md only):
# the day-run table ("review a diff -> OPUS 5.5") must NOT reach a GLM session.
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$NOSAVER_ROOT" "$ZAI")"
expect "11j z.ai + day-run on + L3 file absent -> no day-run table" "$out" 'L3 rules missing' 'ROUTING TABLE'
expect "11j no DAY-RUN MODE text either" "$out" 'withheld' 'DAY-RUN MODE'
expect_msg "11j systemMessage says the L3 rules are missing" "$out" 'L3 rules missing'
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$NOSAVER_ROOT" "$ZAI" CC_ROUTER_WORKER=1)"
expect "11j' worker + worker file absent -> warning, no day-run table" "$out" 'GLM-WORKER.md is missing' 'ROUTING TABLE'

# 11k-11n: provider detection = the HOST of ANTHROPIC_BASE_URL, lowercased.
L1ENV=CC_WORKER_MODE=light
expect "11k uppercase z.ai URL -> L3" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=HTTPS://API.Z.AI/api/anthropic)" 'SAVER LEVEL L3' 'SAVER LEVEL L1'
expect "11k' uppercase Anthropic URL -> still Anthropic (L1)" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=HTTPS://API.ANTHROPIC.COM)" 'SAVER LEVEL L1' 'SAVER LEVEL L3'
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic)"
expect "11l api.deepseek.com -> L3" "$out" 'SAVER LEVEL L3' 'SAVER LEVEL L1'
expect_msg "11l systemMessage names the deepseek host" "$out" 'api.deepseek.com'
expect "11l' deepseek + CC_ROUTER_WORKER=1 -> worker block" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic CC_ROUTER_WORKER=1)" 'GLM WORKER' 'ROUTING TABLE'
expect "11m https://api.anthropic.com -> normal level resolution (L1)" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=https://api.anthropic.com)" 'SAVER LEVEL L1' 'SAVER LEVEL L3'
expect "11m' anthropic.com with port and path -> L1" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=https://api.anthropic.com:443/v1)" 'SAVER LEVEL L1' 'SAVER LEVEL L3'
expect "11m'' userinfo on the real Anthropic host (user:pw@api.anthropic.com) -> L1" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=https://user:pw@api.anthropic.com/v1)" 'SAVER LEVEL L1' 'SAVER LEVEL L3'
expect "11n query-string trick (?u=api.anthropic.com) -> L3" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" 'ANTHROPIC_BASE_URL=https://evil.example/?u=api.anthropic.com')" 'SAVER LEVEL L3' 'SAVER LEVEL L1'
expect "11n' userinfo trick (api.anthropic.com@evil.example) -> L3" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" 'ANTHROPIC_BASE_URL=https://api.anthropic.com@evil.example/')" 'SAVER LEVEL L3' 'SAVER LEVEL L1'
expect "11n'' lookalike host (notanthropic.com) -> L3" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" ANTHROPIC_BASE_URL=https://notanthropic.com)" 'SAVER LEVEL L3' 'SAVER LEVEL L1'
# Node's URL parser reads `\` as `/` for http(s), so this one connects to evil.com.
expect "11n''' backslash trick (evil.com<backslash>@api.anthropic.com) -> L3" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" "$L1ENV" 'ANTHROPIC_BASE_URL=https://evil.com\@api.anthropic.com/')" 'SAVER LEVEL L3' 'SAVER LEVEL L1'

# 11o: a leading UTF-8 BOM on the worker-mode file is ignored.
printf '\357\273\277glm\r\n' > "$FAKE_HOME/.claude/worker-mode"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT")"
expect "11o BOM-prefixed 'glm' worker-mode -> L2" "$out" 'SAVER LEVEL L2' 'treated as L0'
rm -f "$FAKE_HOME/.claude/worker-mode"

# 11p: the env level is normalised like the file.
expect "11p CC_WORKER_MODE=TIGHT -> L3" \
  "$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" CC_WORKER_MODE=TIGHT)" 'SAVER LEVEL L3' 'treated as L0'

# --- case 12: routing-violation counter (PostToolUse on Agent) ---
#
# Same gate and level as the SessionStart hook (both source hooks/lib-saver-level.sh).
# A violation = haiku at L1/L2/L3, or sonnet at L2/L3, unless a GLM peak refusal was
# logged in the last 10 min. The counter must print {} and exit 0 on EVERY path.
CNT="$BAJZI_DIR/hooks/routing-counter.sh"
viol="$FAKE_CWD/runtime/routing-violations.log"; rm -f "$viol" "$TMP/peak.log"
printf 'day-run\n' > "$FAKE_HOME/.claude/bajzi-mode"; rm -f "$FAKE_HOME/.claude/worker-mode"
agent() { printf '{"tool_name":"Agent","tool_input":{"model":"%s"},"cwd":"%s"}' "$1" "$FAKE_CWD"; }
cnt_raw() { # stdin = payload, then env pairs
    env -u CC_WORKER_MODE -u ANTHROPIC_BASE_URL HOME="$FAKE_HOME" CC_PEAK_LOG="$TMP/peak.log"         CLAUDE_PROJECT_DIR="$TMP/nocwd" "$@" bash "$CNT"; }
cnt() { # $1 model, then env pairs
    local m="$1"; shift; agent "$m" | cnt_raw "$@"; }
out=$(cnt haiku CC_WORKER_MODE=light); rc=$?
[ "$out" = "{}" ] && [ "$rc" -eq 0 ] && pass "12a counter prints {} and exits 0" || fail "12a" "rc=$rc $out"
grep -q 'level=light model=haiku' "$viol" 2>/dev/null && pass "12b L1 + haiku is logged" || fail "12b" "no line"
rm -f "$viol"; cnt sonnet CC_WORKER_MODE=light >/dev/null
[ ! -s "$viol" ] && pass "12c L1 + sonnet is NOT a violation" || fail "12c" "$(cat "$viol")"
cnt sonnet CC_WORKER_MODE=glm >/dev/null
grep -q 'level=glm model=sonnet' "$viol" 2>/dev/null && pass "12d L2 + sonnet is logged" || fail "12d" "missing"
rm -f "$viol"; cnt opus CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12e opus is never a violation" || fail "12e" "$(cat "$viol")"
rm -f "$viol"; printf '%s entry=glm\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$TMP/peak.log"
cnt haiku CC_WORKER_MODE=light >/dev/null
[ ! -s "$viol" ] && pass "12f within 10 min of a peak refusal -> not logged" || fail "12f" "$(cat "$viol")"
rm -f "$viol"; printf '%s entry=glm\n' "$(date -u -d '-11 minutes' +%Y-%m-%dT%H:%M:%S.000Z)" > "$TMP/peak.log"
cnt haiku CC_WORKER_MODE=light >/dev/null
grep -q 'model=haiku' "$viol" 2>/dev/null && pass "12f' peak refusal older than 10 min -> logged" || fail "12f'" "no line"
rm -f "$viol" "$TMP/peak.log"; cnt haiku CC_WORKER_MODE=claude >/dev/null
[ ! -s "$viol" ] && pass "12g L0 never logs" || fail "12g" "$(cat "$viol")"
# 12h: gate closed. The worker-mode FILE says glm (a violation level) but day-run is
# off and neither CC_WORKER_MODE nor a non-Anthropic provider is set.
printf 'normal\n' > "$FAKE_HOME/.claude/bajzi-mode"; printf 'glm\n' > "$FAKE_HOME/.claude/worker-mode"
rm -rf "$FAKE_CWD/runtime"
out=$(cnt haiku); [ "$out" = "{}" ] && pass "12h gate closed (day-run off, no env, Anthropic) prints {}" || fail "12h" "$out"
[ ! -e "$FAKE_CWD/runtime" ] && pass "12h' gate closed -> nothing written, not even runtime/" || fail "12h'" "$(ls -la "$FAKE_CWD/runtime" 2>&1)"
mkdir -p "$FAKE_CWD/runtime"
# 12i: same files, but the provider is non-Anthropic -> gate open, level forced to tight.
cnt sonnet CC_WORKER_MODE=light ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic >/dev/null
grep -q 'level=tight model=sonnet' "$viol" 2>/dev/null && pass "12i non-Anthropic provider opens the gate and counts as tight" || fail "12i" "$(cat "$viol" 2>&1)"
rm -f "$viol"
cnt sonnet ANTHROPIC_BASE_URL='https://evil.com\@api.anthropic.com/' >/dev/null
grep -q 'level=tight model=sonnet' "$viol" 2>/dev/null && pass "12i' backslash host trick is non-Anthropic for the counter too" || fail "12i'" "$(cat "$viol" 2>&1)"
printf 'day-run\n' > "$FAKE_HOME/.claude/bajzi-mode"; rm -f "$viol" "$FAKE_HOME/.claude/worker-mode"
# 12j: no model on the dispatch = the session default. The built-in Explore agent
# INHERITS the session model (Claude Code docs, sub-agents, since v2.1.198), so a
# model-less Explore dispatch is NOT a haiku dispatch.
printf '{"tool_name":"Agent","tool_input":{"subagent_type":"Explore"},"cwd":"%s"}' "$FAKE_CWD" | cnt_raw CC_WORKER_MODE=light >/dev/null
[ ! -s "$viol" ] && pass "12j no model + subagent_type=Explore -> session default, not logged" || fail "12j" "$(cat "$viol")"
# 12k: only tool_input.model counts -- a "model" key in tool_response, or the word
# inside the prompt text, must not be read as the dispatch model.
printf '{"tool_name":"Agent","tool_input":{"prompt":"use \\"model\\":\\"haiku\\" here","subagent_type":"Explore"},"tool_response":{"model":"haiku"},"cwd":"%s"}' "$FAKE_CWD" \
    | cnt_raw CC_WORKER_MODE=light >/dev/null
[ ! -s "$viol" ] && pass "12k model outside tool_input is ignored" || fail "12k" "$(cat "$viol")"
printf '{"tool_response":{"model":"opus"},"tool_input":{"description":"x","model":"haiku"},"cwd":"%s"}' "$FAKE_CWD" \
    | cnt_raw CC_WORKER_MODE=light >/dev/null
grep -q 'model=haiku' "$viol" 2>/dev/null && pass "12k' tool_input.model found whatever the key order" || fail "12k'" "no line"
rm -f "$viol"
# 12l: never fails, never blocks.
for bad in '' 'not json' '{"tool_input":{"model":"haiku"' '{"tool_input":{"model":"hai\'; do
    out=$(printf '%s' "$bad" | cnt_raw CC_WORKER_MODE=light); rc=$?
    [ "$out" = "{}" ] && [ "$rc" -eq 0 ] || { fail "12l malformed stdin '$bad'" "rc=$rc $out"; continue; }
    pass "12l malformed stdin '${bad:0:24}' -> {} exit 0"
done
# 12m: a model value cannot inject extra log lines.
rm -f "$viol"
printf '{"tool_input":{"model":"haiku\\nFAKE level=x"},"cwd":"%s"}' "$FAKE_CWD" | cnt_raw CC_WORKER_MODE=light >/dev/null
[ "$(wc -l < "$viol" 2>/dev/null)" = "1" ] && ! grep -q '^FAKE' "$viol" && pass "12m one line per dispatch, no injection" || fail "12m" "$(cat "$viol" 2>&1)"
rm -f "$viol"
# 12n: no model on the dispatch -> the agent DEFINITION's frontmatter model counts.
# Lookup order: <cwd>/.claude/agents, $HOME/.claude/agents, then for plugin:name the
# plugin dirs under $HOME/.claude/plugins (cache/*/<plugin>/*/agents, marketplaces/*/plugins/<plugin>/agents).
# inherit / no model line / no file = the session model, never counted.
mkagent() { # $1 file, $2 model line ('' = none)
    mkdir -p "$(dirname "$1")"
    { printf -- '---\nname: x\ndescription: d\n'; [ -n "$2" ] && printf '%s\n' "$2"; printf -- '---\n\nbody\n'; } > "$1"; }
sub() { printf '{"tool_name":"Agent","tool_input":{"description":"d","subagent_type":"%s","prompt":"p"},"cwd":"%s"}' "$1" "$FAKE_CWD"; }
mkagent "$FAKE_CWD/.claude/agents/proj-rev.md" 'model: sonnet'
mkagent "$FAKE_HOME/.claude/agents/home-fast.md" 'model: "haiku"'
mkagent "$FAKE_HOME/.claude/agents/inh.md" 'model: inherit'
mkagent "$FAKE_HOME/.claude/agents/nomodel.md" ''
mkagent "$FAKE_HOME/.claude/agents/shadow.md" 'model: sonnet'
mkagent "$FAKE_CWD/.claude/agents/shadow.md" 'model: inherit'
printf -- '---\nname: late\n---\nmodel: sonnet\n' > "$FAKE_HOME/.claude/agents/late.md"
mkagent "$FAKE_HOME/.claude/plugins/cache/mk1/fakeplug/1.2.3/agents/code-reviewer.md" 'model: sonnet'
mkagent "$FAKE_HOME/.claude/plugins/marketplaces/mk2/plugins/mktplug/agents/scout.md" 'model: haiku'
mkagent "$FAKE_HOME/.claude/plugins/cache/mk1/otherplug/1.0.0/agents/pinned.md" 'model: sonnet'
rm -f "$viol"; sub proj-rev | cnt_raw CC_WORKER_MODE=glm >/dev/null
grep -q 'level=glm model=sonnet' "$viol" 2>/dev/null && pass "12n <cwd>/.claude/agents sonnet-pinned at L2 -> logged" || fail "12n" "$(cat "$viol" 2>&1)"
rm -f "$viol"; sub home-fast | cnt_raw CC_WORKER_MODE=light >/dev/null
grep -q 'level=light model=haiku' "$viol" 2>/dev/null && pass "12n2 ~/.claude/agents haiku-pinned (quoted) at L1 -> logged" || fail "12n2" "$(cat "$viol" 2>&1)"
rm -f "$viol"; sub inh | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12o model: inherit -> session model, not logged" || fail "12o" "$(cat "$viol")"
sub nomodel | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12o2 no model line -> not logged" || fail "12o2" "$(cat "$viol")"
sub late | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12o3 model: after the frontmatter is ignored" || fail "12o3" "$(cat "$viol")"
sub shadow | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12o4 project agent shadows the home agent of the same name" || fail "12o4" "$(cat "$viol")"
sub does-not-exist | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12p missing agent file -> not logged" || fail "12p" "$(cat "$viol")"
sub 'fakeplug:pinned' | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12p2 plugin name narrows the search (otherplug's agent not used)" || fail "12p2" "$(cat "$viol")"
sub '../agents/proj-rev' | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12p3 a path in subagent_type resolves nothing" || fail "12p3" "$(cat "$viol")"
sub 'fakeplug:code-reviewer' | cnt_raw CC_WORKER_MODE=glm >/dev/null
grep -q 'level=glm model=sonnet' "$viol" 2>/dev/null && pass "12q plugin:name resolves via plugins/cache" || fail "12q" "$(cat "$viol" 2>&1)"
rm -f "$viol"; sub 'mktplug:scout' | cnt_raw CC_WORKER_MODE=light >/dev/null
grep -q 'level=light model=haiku' "$viol" 2>/dev/null && pass "12q2 plugin:name resolves via plugins/marketplaces" || fail "12q2" "$(cat "$viol" 2>&1)"
rm -f "$viol"
# an explicit tool_input.model wins over the definition.
printf '{"tool_input":{"subagent_type":"proj-rev","model":"opus"},"cwd":"%s"}' "$FAKE_CWD" | cnt_raw CC_WORKER_MODE=tight >/dev/null
[ ! -s "$viol" ] && pass "12r explicit tool_input.model overrides the frontmatter" || fail "12r" "$(cat "$viol")"
rm -rf "$FAKE_CWD/.claude" "$FAKE_HOME/.claude/agents" "$FAKE_HOME/.claude/plugins" "$viol"
# 12s: the hook fires for both tool names (Agent; Task on older CLI builds).
HOOKS_JSON="$BAJZI_DIR/hooks/hooks.json"
tr -d ' \n\r' < "$HOOKS_JSON" | grep -qF '"PostToolUse":[{"matcher":"Agent|Task","hooks":[{"type":"command","command":"bash\"${CLAUDE_PLUGIN_ROOT}/hooks/routing-counter.sh\""' \
    && pass "12s hooks.json PostToolUse matcher is Agent|Task -> routing-counter.sh" || fail "12s" "matcher/command not found"

# --- case 13: dispatch guard (PreToolUse on Agent|Task) ---
#
# Same gate as the counter (lib-saver-level.sh). Gate open: a REVIEW dispatch
# (description + first 600 chars of prompt say "review", or subagent_type does)
# must carry code-review-graph output or 'GRAPH: n/a single-file <path>' (R1); a
# fix/re-review must not send the fixer to a full -brief.md / -review*.md (R2)
# and stays <= 24576 chars (R3). Every deny test asserts WHICH rule refused.
DG="$BAJZI_DIR/hooks/dispatch-guard.sh"
dlog="$FAKE_CWD/runtime/dispatch-sizes.log"
dg_raw() { # stdin = payload, then env pairs
    env -u CC_WORKER_MODE -u ANTHROPIC_BASE_URL HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$TMP/nocwd" "$@" bash "$DG"; }
disp() { # $1 description, $2 subagent_type, $3 prompt (already JSON-safe)
    printf '{"tool_name":"Agent","tool_input":{"description":"%s","subagent_type":"%s","prompt":"%s"},"cwd":"%s"}' \
        "$1" "$2" "$3" "$FAKE_CWD"; }
dg() { local d="$1" s="$2" p="$3"; shift 3; disp "$d" "$s" "$p" | dg_raw "$@"; }
is_allow() { [ "$1" = "{}" ]; }
DENY_HEAD='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"dispatch-guard '
is_deny() { # $1 output, $2 rule id -- the exact shape AND the rule that refused
    printf '%s' "$1" | json_ok || return 1
    case "$1" in "$DENY_HEAD$2: "*'"}}') return 0 ;; esac
    return 1; }
lastlog() { tail -n 1 "$dlog" 2>/dev/null; }
logf() { lastlog | awk -F'\t' -v n="$1" '{ print $n }'; }
# 13a: gate closed (day-run off, no env, Anthropic) -> {} and nothing written.
printf 'normal\n' > "$FAKE_HOME/.claude/bajzi-mode"; rm -f "$FAKE_HOME/.claude/worker-mode"
rm -rf "$FAKE_CWD/runtime"
out=$(dg 'review B3' 'general-purpose' 'Review the diff for task B3.'); rc=$?
is_allow "$out" && [ "$rc" -eq 0 ] && pass "13a gate closed: review without graph -> {}" || fail "13a" "rc=$rc $out"
[ ! -e "$FAKE_CWD/runtime" ] && pass "13a' gate closed -> no log, not even runtime/" || fail "13a'" "$(ls -la "$FAKE_CWD/runtime" 2>&1)"
mkdir -p "$FAKE_CWD/runtime"
printf 'day-run\n' > "$FAKE_HOME/.claude/bajzi-mode"
G=CC_WORKER_MODE=glm
# 13b: R1.
out=$(dg 'review task B3' 'general-purpose' 'Review the diff abc..def for spec and quality.' $G)
is_deny "$out" R1 && pass "13b review without graph -> deny R1" || fail "13b" "$out"
[ "$(logf 2)" = "REVIEW" ] && [ "$(logf 5)" = "deny:R1" ] && pass "13b' log: REVIEW ... deny:R1" || fail "13b'" "$(lastlog)"
out=$(dg 'check B3' 'feature-dev:code-reviewer' 'Look at the diff abc..def.' $G)
is_deny "$out" R1 && pass "13b2 subagent_type with review -> REVIEW -> deny R1" || fail "13b2" "$out"
out=$(dg 'REVIEW task B3' 'general-purpose' 'Look at the diff abc..def.' $G)
is_deny "$out" R1 && pass "13b3 classification is case-insensitive" || fail "13b3" "$out"
out=$(dg 'review task B3' 'general-purpose' 'Review abc..def.\nGRAPH: n/a single-file' $G)
is_deny "$out" R1 && pass "13b4 GRAPH opt-out without a path does not count" || fail "13b4" "$out"
# 13c-13e: graph markers.
out=$(dg 'review task B3' 'general-purpose' 'Review abc..def.\nGraph (detect-changes --brief): 3 files' $G)
is_allow "$out" && pass "13c review with detect-changes -> allow" || fail "13c" "$out"
[ "$(logf 5)" = "allow" ] && pass "13c' log: allow" || fail "13c'" "$(lastlog)"
out=$(dg 'review task B3' 'general-purpose' 'Review abc..def. get_review_context_tool said: x.sh:10-40' $G)
is_allow "$out" && pass "13d review with get_review_context_tool -> allow" || fail "13d" "$out"
out=$(dg 'review task B3' 'general-purpose' 'Review abc..def. Blast radius: runtime/graph-b3.json' $G)
is_allow "$out" && pass "13d2 review with a graph-*.json path -> allow" || fail "13d2" "$out"
out=$(dg 'review task B3' 'general-purpose' 'Review abc..def.\nGRAPH: n/a single-file x.sh\nthanks' $G)
is_allow "$out" && pass "13e GRAPH: n/a single-file x.sh -> allow" || fail "13e" "$out"
# 13f-13h: R2.
out=$(dg 're-review B3 fix' 'general-purpose' 'Delta review. detect-changes --brief: 1 file. Read task-B3-brief.md first.' $G)
is_deny "$out" R2 && pass "13f re-review pointing at task-B3-brief.md -> deny R2" || fail "13f" "$out"
[ "$(logf 2)" = "REREVIEW" ] && [ "$(logf 5)" = "deny:R2" ] && pass "13f' log: REREVIEW ... deny:R2" || fail "13f'" "$(lastlog)"
out=$(dg 're-review B3 fix' 'general-purpose' 'detect-changes --brief: 1 file. See .superpowers/sdd/x/task-B3-rereview1.md' $G)
is_deny "$out" R2 && pass "13g re-review pointing at task-B3-rereview1.md -> deny R2" || fail "13g" "$out"
out=$(dg 'fix round 1 B3' 'general-purpose' 'Finding 1 at x.sh:12. Details in task-B3-review.md' $G)
is_deny "$out" R2 && pass "13g2 fix round pointing at task-B3-review.md -> deny R2" || fail "13g2" "$out"
out=$(dg 're-review B3 fix' 'general-purpose' 'detect-changes --brief: 1 file. Append the verdict to task-B3-report.md' $G)
is_allow "$out" && pass "13h re-review with task-B3-report.md + graph -> allow" || fail "13h" "$out"
# 13i-13j: fix rounds.
out=$(dg 'fix round 1 B3' 'general-purpose' 'Finding: x.sh:12 drops the exit code. Excerpt: foo || true. Test: bash t.sh' $G)
is_allow "$out" && pass "13i fix round without graph -> allow (R1 exempt)" || fail "13i" "$out"
# R3 cap = 24576 characters (24 KB; interim, so a batched fix with a full findings list fits).
p24k=$(head -c 24576 /dev/zero | tr '\0' a)
out=$(dg 'fix r2 B3' 'general-purpose' "${p24k}b" $G)
is_deny "$out" R3 && pass "13j fix prompt of 24577 chars -> deny R3" || fail "13j" "${out:0:200}"
[ "$(logf 4)" = "24577" ] && [ "$(logf 5)" = "deny:R3" ] && pass "13j' log: 24577 ... deny:R3" || fail "13j'" "$(lastlog)"
out=$(dg 'fix r2 B3' 'general-purpose' "$p24k" $G)
is_allow "$out" && pass "13j2 fix prompt of exactly 24576 chars -> allow" || fail "13j2" "${out:0:200}"
out=$(dg 're-review B3 fix' 'general-purpose' "detect-changes ${p24k}" $G)
is_deny "$out" R3 && pass "13j3 re-review over 24576 chars with graph -> deny R3" || fail "13j3" "${out:0:200}"
out=$(dg 'fix r2 B3' 'general-purpose' "$(head -c 6001 /dev/zero | tr '\0' a)" $G)
is_allow "$out" && pass "13j4 fix prompt of 6001 chars (the old cap) -> allow" || fail "13j4" "${out:0:200}"
# characters, not bytes: 24576 x e-acute is 49152 bytes and still passes.
out=$(dg 'fix r2 B3' 'general-purpose' "$(printf '%s' "$p24k" | LC_ALL=C sed 's/a/é/g')" $G)
is_allow "$out" && [ "$(logf 4)" = "24576" ] && pass "13j5 24576 two-byte chars (49152 bytes) -> allow" || fail "13j5" "${out:0:200} $(lastlog)"
# 13k: OTHER.
rm -f "$dlog"
out=$(dg 'implement task B5' 'general-purpose' 'Implement the parser. No preview needed.' $G)
is_allow "$out" && pass "13k OTHER dispatch (preview is not review) -> allow" || fail "13k" "$out"
[ "$(wc -l < "$dlog" 2>/dev/null)" = "1" ] && [ "$(logf 2)" = "OTHER" ] && [ "$(logf 3)" = "general-purpose" ] \
    && [ "$(logf 4)" = "40" ] && [ "$(logf 5)" = "allow" ] \
    && lastlog | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z	' \
    && pass "13k' one log line: ISO, OTHER, subagent_type, 40 chars, allow" || fail "13k'" "$(cat "$dlog" 2>&1)"
out=$(dg 'implement task B5' 'general-purpose' 'Implement it; context in task-B3-review.md' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13k2 a *-review.md file name alone does not make a REVIEW" || fail "13k2" "$out $(lastlog)"
# 13q-13v (fix round 1): REREVIEW > FIX > REVIEW > OTHER; the prompt body never
# makes a REVIEW; fixes are exempt from R1; a review file as a WRITE target is fine.
out=$(dg 'Implement Task 3: add reviewer field' 'general-purpose' 'Add the reviewer field to the model.' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13q1 'reviewer' is not the word review -> allow" || fail "13q1" "$out $(lastlog)"
out=$(dg 'Implement it, then self-review your diff and commit.' 'general-purpose' 'Implement it, then self-review your diff and commit.' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13q2 self-review is not a review dispatch -> allow" || fail "13q2" "$out $(lastlog)"
out=$(dg 'run tests' 'general-purpose' 'Run the suite and review the failures.' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13q3 review in the prompt body only -> allow" || fail "13q3" "$out $(lastlog)"
out=$(dg 'Fix round 1 B3' 'general-purpose' 'Apply the two review findings below. x.sh:12 drops rc. Test: bash t.sh' $G)
is_allow "$out" && [ "$(logf 2)" = "FIX" ] && pass "13q4 plain fix round with review findings -> FIX, allow" || fail "13q4" "$out $(lastlog)"
out=$(dg 'Address B3 findings' 'general-purpose' 'Read task-B3-review.md and task-B3-brief.md and fix everything' $G)
is_deny "$out" R2 && [ "$(logf 2)" = "FIX" ] && pass "13r the incident (Address findings + read brief/review) -> deny R2" || fail "13r" "$out $(lastlog)"
out=$(dg 'Fix B3 review findings' 'general-purpose' 'detect-changes --brief: 2 files. Read task-B3-brief.md first.' $G)
is_deny "$out" R2 && [ "$(logf 2)" = "FIX" ] && pass "13r2 'Fix ... review findings' is FIX, not REVIEW -> deny R2" || fail "13r2" "$out $(lastlog)"
out=$(dg 're-review B4b fix' 'general-purpose' 'detect-changes --brief: 1 file. Write your verdict to D:/x/task-B4b-rereview1.md' $G)
is_allow "$out" && pass "13s review file as a write target -> allow" || fail "13s" "$out"
out=$(dg 're-review B4b fix' 'general-purpose' 'detect-changes --brief: 1 file. Append the verdict to D:/AI/projektek/ClaudeCode/claude-orchestrator/.superpowers/sdd/2026-09-22-saver-levels/task-B4b-rereview1.md' $G)
is_allow "$out" && pass "13s2 write target with a long path -> allow" || fail "13s2" "$out"
out=$(dg 're-review B3 fix' 'general-purpose' 'detect-changes --brief: 1 file. Then read task-B3-rereview1.md' $G)
is_deny "$out" R2 && pass "13t re-review told to read task-B3-rereview1.md -> deny R2" || fail "13t" "$out"
out=$(dg 're-review B3 fix' 'general-purpose' 'Check the fix diff abc..def against finding 1.' $G)
is_deny "$out" R1 && [ "$(logf 2)" = "REREVIEW" ] && pass "13u re-review without a graph marker -> deny R1" || fail "13u" "$out $(lastlog)"
out=$(dg 'Fix round 2' 'feature-dev:code-reviewer' 'Finding: x.sh:3 quotes. Excerpt: echo $x. Test: bash t.sh' $G)
is_allow "$out" && [ "$(logf 2)" = "FIX" ] && pass "13v fix to a reviewer agent -> FIX, exempt from R1" || fail "13v" "$out $(lastlog)"
# 13w-13z (fix round 2): file names never classify; the (fix|address|apply|resolve)
# ... findings pattern reads the DESCRIPTION only; the write-target exception needs
# a whole verb + to/into/in right before the path; code-review is a review.
out=$(dg 'Implement per task-B3-rereview1.md' 'general-purpose' 'Implement the parser.' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13w a *-rereview1.md name in the description is not a REREVIEW" || fail "13w" "$out $(lastlog)"
out=$(dg 'Implement Task B5' 'general-purpose' 'Read D:/x/task-B5-brief.md. Resolve any lint findings in files you touch, then commit.' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13x implementer 'resolve any lint findings' + its brief -> allow" || fail "13x" "$out $(lastlog)"
out=$(dg 'Implement Task B5' 'general-purpose' 'Implement per task-B5-brief.md. Run tests, fix failures, report findings in task-B5-report.md.' $G)
is_allow "$out" && [ "$(logf 2)" = "OTHER" ] && pass "13x2 implementer 'fix failures, report findings' + its brief -> allow" || fail "13x2" "$out $(lastlog)"
out=$(dg 'Fix round 1 B3' 'general-purpose' 'Fix the output bug. Read task-B3-review.md for details.' $G)
is_deny "$out" R2 && pass "13y 'output' in another sentence is not a write target -> deny R2" || fail "13y" "$out"
out=$(dg 'Fix round 1 B3' 'general-purpose' 'Rewrite per the notes in task-B3-review.md' $G)
is_deny "$out" R2 && pass "13y2 'Rewrite ... in' is not the word write -> deny R2" || fail "13y2" "$out"
# 13y3-13y5 (fix round 3, I-1): the verb-to-path gap is at most 24 chars, stops
# at . ; : , and "in" is not a write preposition.
out=$(dg 'Fix round 1 B3' 'general-purpose' 'Save time: just work through the notes in task-B3-review.md' $G)
is_deny "$out" R2 && [ "$(logf 2)" = "FIX" ] && pass "13y3 'Save time: ... notes in <review>' -> deny R2" || fail "13y3" "$out $(lastlog)"
out=$(dg 'Address B3 findings' 'general-purpose' 'Output a fixed version; the findings are listed in task-B3-review.md' $G)
is_deny "$out" R2 && [ "$(logf 2)" = "FIX" ] && pass "13y4 'Output ...; listed in <review>' -> deny R2" || fail "13y4" "$out $(lastlog)"
out=$(dg 'Fix round 1 B3' 'general-purpose' 'Output the corrected function and compare it to task-B3-review.md' $G)
is_deny "$out" R2 && [ "$(logf 2)" = "FIX" ] && pass "13y5 verb far from 'to <review>' (gap > 24) -> deny R2" || fail "13y5" "$out $(lastlog)"
out=$(dg 'Code-review task B3' 'general-purpose' 'Look at the diff abc..def.' $G)
is_deny "$out" R1 && [ "$(logf 2)" = "REVIEW" ] && pass "13z Code-review is a review -> deny R1 without a marker" || fail "13z" "$out $(lastlog)"
# 13l: never wedges a dispatch (truncated payloads included, even one that reads as a review).
for bad in '' 'not json' '{"tool_input":{"prompt":"review' '{"tool_input":{"prompt":"rev\' \
    '{"tool_input":{"description":"review","prompt":"Review abc."}'; do
    out=$(printf '%s' "$bad" | dg_raw $G); rc=$?
    [ "$out" = "{}" ] && [ "$rc" -eq 0 ] || { fail "13l malformed stdin '$bad'" "rc=$rc $out"; continue; }
    pass "13l malformed stdin '${bad:0:24}' -> {} exit 0"
done
# 13m: registered as PreToolUse on Agent|Task, next to the Bash noise filter.
hj=$(tr -d ' \n\r' < "$BAJZI_DIR/hooks/hooks.json")
pre="${hj%%\"PostToolUse\"*}"; pre="${pre#*\"PreToolUse\"}"
case "$pre" in
    *'{"matcher":"Agent|Task","hooks":[{"type":"command","command":"bash\"${CLAUDE_PLUGIN_ROOT}/hooks/dispatch-guard.sh\"","timeout":5}]}'*)
        case "$pre" in *'hooks/noise-filter.sh'*) pass "13m hooks.json PreToolUse Agent|Task -> dispatch-guard.sh (noise filter kept)" ;;
            *) fail "13m" "noise filter entry lost" ;; esac ;;
    *) fail "13m" "PreToolUse dispatch-guard entry not found" ;;
esac
# 13m2: the merged hooks.json wires every hook of both branches exactly once per event.
wired=$(node -e 'const h=require(process.argv[1]).hooks;const o=[];for(const[e,a]of Object.entries(h))for(const m of a)for(const c of m.hooks)o.push(e+":"+c.command.replace(/.*\/hooks\//,"").replace(/"$/,""));console.log(o.sort().join(" "))' "$BAJZI_DIR/hooks/hooks.json" 2>&1)
want="PostToolUse:node/context-guard.js PostToolUse:node/injection-scan.js PostToolUse:routing-counter.sh PreToolUse:dispatch-guard.sh PreToolUse:node/context-guard.js PreToolUse:node/secret-guard.js PreToolUse:noise-filter.sh SessionStart:day-run-mode.sh SessionStart:handoff-load.sh SessionStart:methodology-guard.sh"
[ "$wired" = "$want" ] && pass "13m2 hooks.json: all 10 hooks of both branches wired exactly once" || fail "13m2" "got: $wired"
# 13n: non-ASCII prompt -- characters, not bytes, under both locales; \u escape = 1 char.
for loc in C C.UTF-8; do
    rm -f "$dlog"
    out=$(dg 'implement' 'general-purpose' 'árvíztűrő é tükörfúrógép' $G LC_ALL=$loc); rc=$?
    is_allow "$out" && [ "$rc" -eq 0 ] && [ "$(logf 4)" = "24" ] \
        && pass "13n LC_ALL=$loc non-ASCII prompt -> 24 chars logged, no crash" || fail "13n $loc" "rc=$rc $out $(lastlog)"
done
# 13o: input cannot inject log lines or tabs.
rm -f "$dlog"
dg 'implement' 'gen\teral\nFAKE' 'x' $G >/dev/null
[ "$(wc -l < "$dlog" 2>/dev/null)" = "1" ] && [ "$(awk -F'\t' '{ print NF }' "$dlog")" = "5" ] && ! grep -q '^FAKE' "$dlog" \
    && pass "13o one 5-field line, no injection" || fail "13o" "$(cat "$dlog" 2>&1)"
# 13p: an unwritable log never changes the decision.
rm -rf "$FAKE_CWD/runtime"; printf 'x' > "$FAKE_CWD/runtime"
out=$(dg 'review task B3' 'general-purpose' 'Review abc..def.' $G)
is_deny "$out" R1 && pass "13p log write failure -> decision unchanged (deny R1)" || fail "13p" "$out"
rm -f "$FAKE_CWD/runtime"; mkdir -p "$FAKE_CWD/runtime"

# --- case 15: the reviewer allow-list line (spec Invariant 3) ---
# day-run on a Claude session appends REVIEWER MODELS from $HOME/.claude/bajzi/config.json; an
# invalid list (GLM id, missing, malformed, empty) gets the stated Opus fallback + a setup warning;
# a non-Anthropic session never gets the line.
rm -f "$FAKE_CWD/runtime/bajzi-mode" "$FAKE_HOME/.claude/worker-mode"
printf 'day-run
' > "$FAKE_HOME/.claude/bajzi-mode"
RMCFG="$FAKE_HOME/.claude/bajzi/config.json"
mkdir -p "$FAKE_HOME/.claude/bajzi"
printf '{"reviewer_models": ["claude-a-1", "claude-b-2"]}' > "$RMCFG"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" BAJZI_HOME=)"
expect "15a valid list -> REVIEWER MODELS line, in order" "$out" 'REVIEWER MODELS (reviewer allow-list; launch the first): claude-a-1, claude-b-2' 'REVIEWER = Opus'
expect "15a rules tail still intact" "$out" 'Day-run never merges\.'
expect_msg "15a no setup warning on a valid list" "$out" 'day-run mode active' 'bajzi:setup'
printf '{"reviewer_models": ["claude-a-1", "glm-5.3"]}' > "$RMCFG"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" BAJZI_HOME=)"
expect "15b GLM id voids the list -> Opus fallback" "$out" 'REVIEWER = Opus (no version id' 'launch the first): claude-a-1'
expect_msg "15b warns: run /bajzi:setup" "$out" 'reviewer allow-list invalid, run /bajzi:setup'
for bad in '{"reviewer_models": [' '{"reviewer_models": []}' '{"other": 1}'; do
    printf '%s' "$bad" > "$RMCFG"
    out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" BAJZI_HOME=)"
    expect "15c invalid list ($bad) -> Opus fallback" "$out" 'REVIEWER = Opus (no version id'
done
rm -f "$RMCFG"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" BAJZI_HOME=)"
expect "15d missing config -> Opus fallback" "$out" 'REVIEWER = Opus (no version id'
printf '{"reviewer_models": ["claude-a-1"]}' > "$RMCFG"
out="$(run_hook_env "$FAKE_CWD" "$FAKE_HOME" "$FAKE_ROOT" BAJZI_HOME= "$ZAI")"
expect "15e non-Anthropic session: no REVIEWER MODELS line" "$out" 'SAVER LEVEL L3' 'launch the first)'
rm -rf "$FAKE_HOME/.claude/bajzi"
# 15f: Fable depletion never restarts on the depleted model, even when entry [0] is Fable.
grep -q 'the first REVIEWER MODELS id that is not a Fable model' "$RULES_MD"     && pass "15f Fable-depletion restart skips Fable ids" || fail "15f" "restart line may name the depleted model"

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
