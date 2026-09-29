#!/usr/bin/env bash
# Proves the PHASE C rules check of SKILL.md refuses a rendered Edit/Write deny
# that covers the run's OWN trees (2026-09-29: `Edit(~/bss-*/**)` matched the
# base worktree ~/bss-night, so story sessions could not write
# runtime/AUTOPILOT-REPORT.md or runtime/handoff/). It runs the very snippet
# SKILL.md ships (extracted, not copied) on the shipped template, rendered with
# a sample BASE / NIGHT_DIR. Pure strings: nothing is created, no claude runs.
#
# Usage:  bash tests/deny-run-tree.sh
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SKILL=$NR_SKILL_DIR/SKILL.md
TMPL=$NR_SKILL_DIR/templates/settings.local.json.tmpl
BASE=$HOME/bss-night
NIGHT=$HOME/night-runs/bss
T=$NR_SCRATCH/deny-run-tree
rm -rf "$T"; mkdir -p "$T"

# The rules-check snippet: the heredoc body under the `python3 - <settings> ...` line.
sed -n "/^python3 - .*settings\.local\.json.*<<'PY'/,/^PY\$/p" "$SKILL" | sed '1d;$d' >"$T/check.py"
grep -q 'UNRENDERED RULE' "$T/check.py" && grep -q 'DENY COVERS RUN TREE' "$T/check.py"
check $? "SKILL.md PHASE C snippet found, with both messages"

render(){ # <out> [extra deny rule]: substitute the config.env values, drop what PHASE C fills or deletes
  python3 - "$TMPL" "$1" "$BASE" "$NIGHT" "${2:-}" <<'PY'
import json, re, sys
tmpl, out, base, night, extra = sys.argv[1:6]
d = json.load(open(tmpl))
sub = {"<BASE_DIR>": base, "<NIGHT_DIR>": night, "<BASE_BRANCH>": "dev", "<BRANCH_PREFIX>": "feat/", "<project>": "bss"}
for k in ("allow", "deny", "ask"):
    if k not in d["permissions"]:
        continue
    rules = []
    for r in d["permissions"][k]:
        for a, b in sub.items():
            r = r.replace(a, b)
        if not re.search(r"<[A-Za-z]", r):
            rules.append(r)
    d["permissions"][k] = rules
if extra:
    d["permissions"]["deny"].append(extra)
json.dump(d, open(out, "w"))
PY
}

run_check(){ # <name> [extra deny rule] -> $T/<name>.out, rc in $RC
  render "$T/$1.json" "${2:-}" || { RC=99; return; }
  python3 - "$T/$1.json" "$BASE" "$NIGHT" <"$T/check.py" >"$T/$1.out" 2>&1; RC=$?
}
expect_pass(){ # <name> <extra deny rule|''> <description>
  run_check "$1" "$2"
  [ "$RC" -eq 0 ] && [ ! -s "$T/$1.out" ]; check $? "$3"
}
expect_fail(){ # <name> <extra rule> <output line the check must print> <description>
  run_check "$1" "$2"
  [ "$RC" -eq 1 ] && grep -qxF "$3" "$T/$1.out"; check $? "$4"
}

expect_pass base ""                       "the shipped template, rendered, passes"
expect_fail bss 'Edit(~/bss-*/**)' 'DENY COVERS RUN TREE: Edit(~/bss-*/**)' \
  "Edit(~/bss-*/**) (covers BASE ~/bss-night) fails"
expect_fail write 'Write(~/bss-night/runtime/**)' 'DENY COVERS RUN TREE: Write(~/bss-night/runtime/**)' \
  "Write(<BASE>/runtime/**) fails"
expect_fail night 'Edit(~/night-runs/**)' 'DENY COVERS RUN TREE: Edit(~/night-runs/**)' \
  "Edit(~/night-runs/**) (covers NIGHT_DIR/wt/S1) fails"
expect_fail abs 'Edit(/runtime/**)' 'DENY COVERS RUN TREE: Edit(/runtime/**)' \
  "a single leading / is BASE-relative: Edit(/runtime/**) fails"
expect_fail rel 'Edit(runtime/**)' 'DENY COVERS RUN TREE: Edit(runtime/**)' \
  "a relative glob is BASE-relative: Edit(runtime/**) fails"
expect_fail root "Edit(/${BASE}/**)" "DENY COVERS RUN TREE: Edit(/${BASE}/**)" \
  "Edit(//<BASE>/**) (absolute root) fails"
expect_pass sibling 'Edit(~/bss-other/**)' "a sibling tree (~/bss-other/**) passes"
expect_pass deeper  'Edit(~/bss-*/secrets/**)' "a narrower protected subtree (~/bss-*/secrets/**) passes"
expect_pass etc     'Edit(//etc/**)'         "a rule outside the run trees (//etc/**) passes"
expect_pass read    'Read(~/bss-*/**)'       "a Read deny is not an edit deny and passes"

# The old check must still fire on a leftover placeholder.
run_check leftover 'Edit(<one Edit line per forbidden path>)'
[ "$RC" -eq 1 ] && grep -qxF 'UNRENDERED RULE: Edit(<one Edit line per forbidden path>)' "$T/leftover.out"
check $? "an unrendered placeholder rule still fails"

nr_summary deny-run-tree
