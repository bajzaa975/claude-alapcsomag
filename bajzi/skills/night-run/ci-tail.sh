#!/usr/bin/env bash
# ci-tail.sh <night-dir> <run-id> — last 80 lines of a failed CI run's log, ANSI-stripped and
# secret-redacted, written to <night-dir>/ci/<run-id>.txt (path printed). Zero LLM tokens.
# exit 2 = bad args, exit 1 = gh missing/failing (no file written).
set -u
[ $# -eq 2 ] && [ -d "$1" ] && case "$2" in ''|*[!0-9]*) false;; esac || {
  echo "usage: ci-tail.sh <existing-night-dir> <digits-only-run-id>" >&2; exit 2; }
ND=$1 RID=$2
command -v gh >/dev/null 2>&1 || { echo "ci-tail.sh: gh not found" >&2; exit 1; }
RAW=$(gh run view "$RID" --log-failed 2>/dev/null) || { echo "ci-tail.sh: gh run view failed" >&2; exit 1; }
[ -n "$RAW" ] || { echo "ci-tail.sh: empty log" >&2; exit 1; }
ESC=$(printf '\033')
N='[A-Za-z0-9_.-]*([Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Kk][Ee][Yy])[A-Za-z0-9_.-]*'
mkdir -p "$ND/ci" || exit 1
OUT=$ND/ci/$RID.txt
printf '%s\n' "$RAW" | tr -d '\r' | sed -E \
  -e "s/${ESC}\[[0-9;?]*[A-Za-z]//g" \
  -e 's/(ghp|gho|ghs)_[A-Za-z0-9_]+/[REDACTED]/g' \
  -e 's/github_pat_[A-Za-z0-9_]+/[REDACTED]/g' \
  -e 's/Bearer +[^ ]+/[REDACTED]/g' \
  -e 's/(AKIA|ASIA)[0-9A-Z]{16}/[REDACTED]/g' \
  -e "s/(\"$N\" *: *)\"[^\"]*\"/\1\"[REDACTED]\"/g" \
  -e "s/($N)=(\"[^\"]*\"|'[^']*'|[^ ]+)/\1=[REDACTED]/g" \
  | tail -n 80 > "$OUT.tmp" && mv "$OUT.tmp" "$OUT" || { rm -f "$OUT.tmp"; exit 1; }
echo "$OUT"
