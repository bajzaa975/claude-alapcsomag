#!/usr/bin/env bash
# tests/ci-tail.sh — ci-tail.sh against a FAKE gh on PATH. Token-shaped samples are assembled
# from fragments at runtime so no literal secret lives in the repo.
#   bash tests/ci-tail.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CT=$HERE/../ci-tail.sh
[ -f "$CT" ] || { echo "FAIL: $CT not found"; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/ci-tail.XXXXXX") || exit 1
trap 'rm -rf "$S"' EXIT
FAILED=0
ok(){ printf 'PASS  %s\n' "$*"; }
bad(){ printf 'FAIL  %s\n' "$*"; FAILED=1; }
mkdir -p "$S/bin" "$S/nd"
cat > "$S/bin/gh" <<'G'
#!/usr/bin/env bash
[ "${FAKE_GH_FAIL:-0}" = 1 ] && exit 1
[ "$1 $2 $4" = "run view --log-failed" ] || exit 3
cat "$FAKE_GH_LOG"
G
chmod +x "$S/bin/gh"
export PATH="$S/bin:$PATH" FAKE_GH_LOG="$S/log"
E=$(printf '\033'); A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
{
  for i in $(seq 1 100); do echo "line $i"; done
  echo "${E}[31mred${E}[0m text"
  echo "t1 gh""p_$A"; echo "t2 gh""o_$A"; echo "t3 gh""s_$A"; echo "t4 github""_pat_$A"
  echo "t5 Author""ization: Bear""er abc.def-123"
  echo "t6 AK""IA0123456789ABCDEF"
  echo "t7 MY_TO""KEN=hunter2 rest"
  echo "t8 {\"api_to""ken\": \"hunter3\"}"
  echo "t9 DB_PASS""WORD=\"hunter 4\""
} > "$S/log"
OUT=$(bash "$CT" "$S/nd" 123) ; rc=$?
[ $rc = 0 ] && [ "$OUT" = "$S/nd/ci/123.txt" ] && [ -f "$OUT" ] && ok "path printed, file written" || bad "path/file rc=$rc out=$OUT"
[ "$(wc -l < "$OUT")" -le 80 ] && ok "capped at 80 lines" || bad "more than 80 lines"
grep -q 'line 1$' "$OUT" && bad "old lines kept" || ok "head dropped"
grep -q "$E" "$OUT" && bad "ANSI left" || ok "ANSI stripped"
grep -q 'red text' "$OUT" && ok "text kept" || bad "text lost"
for n in 1 2 3 4 5 6 7 8 9; do
  l=$(grep "^t$n " "$OUT")
  case "$l" in *"[REDACTED]"*) case "$l" in *"$A"*|*hunter*|*abc.def*|*0123456789ABCDEF*) bad "t$n leaked: $l";; *) ok "t$n redacted";; esac;; *) bad "t$n not redacted: $l";; esac
done
bash "$CT" "$S/nd" 12x >/dev/null 2>&1; [ $? = 2 ] && ok "bad run-id exit 2" || bad "bad run-id"
bash "$CT" "$S/nd" "" >/dev/null 2>&1; [ $? = 2 ] && ok "empty run-id exit 2" || bad "empty run-id"
bash "$CT" "$S/none" 5 >/dev/null 2>&1; [ $? = 2 ] && ok "missing dir exit 2" || bad "missing dir"
FAKE_GH_FAIL=1 bash "$CT" "$S/nd" 456 >/dev/null 2>&1; rc=$?
[ $rc = 1 ] && [ ! -e "$S/nd/ci/456.txt" ] && ok "gh failure exit 1, no file" || bad "gh failure rc=$rc"
exit $FAILED
