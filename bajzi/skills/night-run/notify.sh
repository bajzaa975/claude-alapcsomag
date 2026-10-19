#!/usr/bin/env bash
# notify.sh <message> [<title>] — default night-run notifier (night-watch.sh, when WATCH_NOTIFY_CMD is unset).
# ntfy: topic = $ORCH_NTFY_TOPIC, else the first non-empty line of ${ORCH_NTFY_TOPIC_FILE:-~/.claude/bajzi/ntfy-topic};
#   no topic = skipped silently. The topic is the only access control on ntfy.sh: never printed, never logged.
# Windows toast (NotifyIcon balloon via pwsh, detached): off with ORCH_NOTIFY_NO_TOAST=1.
# Exit 0 = everything attempted worked or was skipped; 1 = the ntfy POST failed.
msg=${1:-}; title=${2:-night-run}
msg=${msg:0:300}
topic=${ORCH_NTFY_TOPIC:-}
if [ -z "$topic" ]; then
  f=${ORCH_NTFY_TOPIC_FILE:-$HOME/.claude/bajzi/ntfy-topic}
  [ -f "$f" ] && topic=$(awk '{ gsub(/^[ \t\r]+|[ \t\r]+$/, ""); if ($0 != "") { print; exit } }' "$f" 2>/dev/null)
fi

case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) win=1;; *) win=0;; esac
[ "${OS:-}" = Windows_NT ] && win=1
if [ "$win" = 1 ] && [ "${ORCH_NOTIFY_NO_TOAST:-}" != 1 ] && command -v pwsh >/dev/null 2>&1; then
  NR_MSG=$msg NR_TITLE=$title setsid pwsh -NoProfile -NonInteractive -Command '
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.Visible = $true
    $n.ShowBalloonTip(5000, $env:NR_TITLE, $env:NR_MSG, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 6
    $n.Dispose()' </dev/null >/dev/null 2>&1 9>&- &
fi

[ -n "$topic" ] || exit 0
printf '%s' "$msg" | curl -sS -m 15 -o /dev/null -f -H "Title: $title" --data-binary @- "https://ntfy.sh/$topic" >/dev/null 2>&1 || exit 1
exit 0
