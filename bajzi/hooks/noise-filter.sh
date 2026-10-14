#!/usr/bin/env bash
# PreToolUse(Bash) hook — keeps noisy command output out of the context window.
#
# WHY PreToolUse AND NOT PostToolUse:
#   PostToolUse can only ADD text (additionalContext); there is no field that
#   replaces or shrinks a tool result. Verified against the Claude Code 2.1.272
#   binary: `updatedInput` appears 103x, `updatedOutput` zero times. So the only
#   place to intervene is BEFORE the command runs.
#
# WHAT IT DOES:
#   For allowlisted noisy commands it returns updatedInput, rewriting
#       npm install
#   into
#       bash "<plugin>/hooks/noise-run.sh" 'npm install'
#   The runner executes the original command unchanged, preserves its exit code
#   (a naive `| tail -20` would NOT — the pipeline would report tail's status and
#   a failed build would look successful), and prints head + error lines + final
#   summary instead of thousands of progress lines.
#
# WHAT IT LEAVES ALONE:
#   Everything not on the allowlist. Short output is never filtered (the runner
#   passes anything under BAJZI_NOISE_KEEP lines through whole).
#
# RTK: this is complementary, not a competitor. rtk's own PreToolUse hook covers
#   git/ls/find/grep/read/pytest/ruff/`err npm run build`; those are excluded
#   here, and anything already starting with `rtk` is skipped, so the two hooks
#   never rewrite the same call.
#
# Disable: BAJZI_NOISE_OFF=1

set -uo pipefail

input=$(cat)

# --- extract tool_input.command -------------------------------------------
# python3 when available (robust against escapes), sed fallback otherwise, in
# keeping with the dependency-free style of the other hooks in this plugin.
cmd=""
if command -v python3 >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("tool_name") == "Bash":
    sys.stdout.write(str(d.get("tool_input", {}).get("command", "")))
' 2>/dev/null)
else
  case "$input" in
    *'"tool_name"'*'"Bash"'*|*'"Bash"'*'"tool_name"'*)
      cmd=$(printf '%s' "$input" \
        | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(\([^"\\]\|\\.\)*\)".*/\1/p' \
        | head -1 \
        | sed -e 's/\\n/\n/g' -e 's/\\t/\t/g' -e 's/\\"/"/g' -e 's/\\\\/\\/g')
      ;;
  esac
fi

[ -z "$cmd" ] && exit 0
[ "${BAJZI_NOISE_OFF:-0}" = "1" ] && exit 0

# --- skip list: already wrapped, or owned by another tool ------------------
case "$cmd" in
  rtk\ *|*noise-run.sh*) exit 0 ;;
esac

# --- allowlist: loud, low-information commands -----------------------------
# Deliberately NOT here: pytest / ruff / git / ls / find / grep  (rtk owns those).
noisy=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    npm\ install*|npm\ i\ *|npm\ ci*|npm\ audit\ fix*|npx\ playwright\ install*) noisy=1 ;;
    yarn\ install*|yarn\ add\ *|pnpm\ install*|pnpm\ add\ *|bun\ install*) noisy=1 ;;
    pip\ install*|pip3\ install*|python\ -m\ pip\ install*|uv\ pip\ install*|uv\ sync*) noisy=1 ;;
    cargo\ build*|cargo\ install*|go\ build*|go\ mod\ download*|go\ install*) noisy=1 ;;
    docker\ build*|docker\ pull*|docker\ compose\ build*|docker\ compose\ up\ --build*) noisy=1 ;;
    apt-get\ install*|apt\ install*|sudo\ apt-get\ install*|sudo\ apt\ install*) noisy=1 ;;
    make|make\ *|gradle\ *|./gradlew\ *|mvn\ *|cmake\ --build*) noisy=1 ;;
    terraform\ init*|terraform\ plan*|npm\ run\ build*) noisy=1 ;;
  esac
done <<EOF
$cmd
EOF

[ "$noisy" -eq 1 ] || exit 0

# `npm run build` is rtk's when rtk is installed (rtk err npm run build).
case "$cmd" in
  npm\ run\ build*) command -v rtk >/dev/null 2>&1 && exit 0 ;;
esac

runner="${CLAUDE_PLUGIN_ROOT:-}/hooks/noise-run.sh"
[ -f "$runner" ] || exit 0

# Single-quote the original command for safe embedding ('\'' dance).
esc=$(printf '%s' "$cmd" | sed "s/'/'\\\\''/g")
new="bash \"$runner\" '$esc'"

if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$new" | python3 -c '
import json,sys
print(json.dumps({"hookSpecificOutput":{
    "hookEventName":"PreToolUse",
    "permissionDecision":"allow",
    "permissionDecisionReason":"bajzi noise-filter: output compacted, exit code preserved",
    "updatedInput":{"command":sys.stdin.read()}}}))
'
else
  esc_json=$(printf '%s' "$new" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"bajzi noise-filter: output compacted, exit code preserved","updatedInput":{"command":"%s"}}}\n' "$esc_json"
fi
exit 0
