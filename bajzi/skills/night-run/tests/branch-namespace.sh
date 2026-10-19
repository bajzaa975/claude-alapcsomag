#!/usr/bin/env bash
# Proves the optional config.env key BRANCH_NAMESPACE (default `feat`) sets the first
# segment of every story branch, <BRANCH_NAMESPACE>/<BRANCH_PREFIX>-<id>-<slug>:
# run.sh's dry-run prompt (all three worktree cases), the rendered BRIEF.md.tmpl
# (CI lookup included) and the rendered settings push allowlist; the default keeps
# today's `feat/` text; a bad value exits 2 naming the key in run.sh and supervise.sh.
# No claude, no git, no gh: dry runs, `supervise.sh --check` refusals and node renders.
#
# Usage:  bash tests/branch-namespace.sh
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

T=$NR_SCRATCH/branch-namespace
rm -rf "$T"; mkdir -p "$T"
has(){ grep -qF -- "$2" "$1"; }

dry(){ # <name> [extra config lines] -> $T/<name>/out, RC
  local nd=$T/$1; shift
  nr_make_night "$nd"; nr_queue "$nd" S1
  nr_config "$nd/config.env" "$nd" "$nd" "$nd/no-claude" "$@"
  ( cd "$T" && bash "$NR_RUN" --config "$nd/config.env" --dry-run >"$nd/out" 2>&1 ); RC=$?
  OUT=$nd/out
}
prompt3(){ # <name> <namespace>: the three worktree-case spellings are all in the prompt
  local b="$2/nrt-S1-slug"
  if [ "$RC" -eq 0 ] && has "$OUT" "Branch: $b in worktree" && has "$OUT" "wt/S1 $b;" && has "$OUT" "-b $b origin/main"; then
    ok "$1: prompt names $b in all three worktree cases"
  else bad "$1: rc $RC, $(grep -m1 'Branch:' "$OUT" | cut -c1-200)"; fi
}

# (1) default: today's feat/ text
dry d1
prompt3 "1 default" feat
# (2) BRANCH_NAMESPACE=bajzi: no feat/ anywhere
dry d2 'BRANCH_NAMESPACE="bajzi"'
prompt3 "2 bajzi" bajzi
if grep -q 'feat/' "$OUT"; then bad "2 bajzi: prompt still says feat/"; else ok "2 bajzi: no feat/ in the prompt"; fi

# the bad-slug message names the branch the slug would have become
for ns in feat bajzi; do
  nd=$T/slug-$ns; nr_make_night "$nd"; printf 'S1|bad slug|-|criteria for S1\n' >"$nd/queue.txt"
  nr_config "$nd/config.env" "$nd" "$nd" "$nd/no-claude" "BRANCH_NAMESPACE=\"$ns\""
  ( cd "$T" && bash "$NR_RUN" --config "$nd/config.env" --dry-run >"$nd/out" 2>&1 )
  if has "$nd/out" "it becomes the branch $ns/nrt-S1-bad slug,"; then ok "2 $ns: bad-slug message names $ns/nrt-S1-bad slug"
  else bad "2 $ns: bad-slug message: $(grep -m1 'slug' "$nd/out" | cut -c1-200)"; fi
done

# (3) a bad value: exit 2 naming the key, run.sh and supervise.sh
dry d3 'BRANCH_NAMESPACE="Bad Name"'
if [ "$RC" -eq 2 ] && has "$OUT" "run.sh: BRANCH_NAMESPACE"; then ok "3 run.sh refuses 'Bad Name': exit 2 naming BRANCH_NAMESPACE"
else bad "3 run.sh 'Bad Name': rc $RC, $(head -2 "$OUT" | tr '\n' '|')"; fi
for v in Feat -x "$(printf 'a%.0s' $(seq 1 32))"; do
  dry d3b "BRANCH_NAMESPACE=\"$v\""
  if [ "$RC" -eq 2 ] && has "$OUT" "BRANCH_NAMESPACE"; then ok "3 run.sh refuses '$v'"; else bad "3 run.sh '$v': rc $RC"; fi
done
dry d3c 'BRANCH_NAMESPACE="a.b_c-9"'
if [ "$RC" -eq 0 ]; then ok "3 run.sh accepts a.b_c-9"; else bad "3 run.sh a.b_c-9: rc $RC, $(head -2 "$OUT" | tr '\n' '|')"; fi
ND=$T/d3; printf 'BRANCH_NAMESPACE="Bad Name"\n' >>"$ND/config.env"
( cd "$T" && timeout 10 bash "$NR_SKILL_DIR/supervise.sh" --check --config "$ND/config.env" >"$ND/sup.out" 2>&1 ); RC=$?
if [ "$RC" -eq 2 ] && has "$ND/sup.out" "supervise.sh: BRANCH_NAMESPACE"; then ok "3 supervise.sh --check refuses 'Bad Name': exit 2 naming BRANCH_NAMESPACE"
else bad "3 supervise.sh 'Bad Name': rc $RC, $(head -2 "$ND/sup.out" | tr '\n' '|')"; fi

# (4)+(5) the templates, rendered by literal replace exactly as PHASE C does
render(){ # <namespace> -> node checks, one "PASS|FAIL <text>" line each
  node - "$NR_SKILL_DIR/templates" "$1" <<'JS'
const fs = require('fs'); const path = require('path');
const [dir, ns] = process.argv.slice(2);
const say = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const sub = (t, a) => Object.entries(a).reduce((s, [k, v]) => s.split(k).join(v), t);
const brief = sub(fs.readFileSync(path.join(dir, 'BRIEF.md.tmpl'), 'utf8'),
  { '{{BRANCH_NAMESPACE}}': ns, '{{BRANCH_PREFIX}}': 'nrt' });
const other = ns === 'feat' ? 'bajzi/' : 'feat/';
say(!brief.includes(other), `4 ${ns}: rendered BRIEF has no ${other}`);
say(brief.includes(`gh run list --branch "${ns}/nrt-<id>-<slug>"`), `4 ${ns}: BRIEF CI lookup uses ${ns}/nrt-<id>-<slug>`);
say(brief.split(`${ns}/nrt-<id>-<slug>`).length - 1 >= 7, `4 ${ns}: every story-branch spelling in BRIEF follows the key`);
const set = JSON.parse(sub(fs.readFileSync(path.join(dir, 'settings.local.json.tmpl'), 'utf8'),
  { '<BRANCH_NAMESPACE>': ns, '<BRANCH_PREFIX>': 'nrt' }));
const push = set.permissions.allow.filter((r) => / push /.test(r) && !r.endsWith(' origin HEAD)'));
say(push.length === 10, `5 ${ns}: 10 named-branch push allow rules (got ${push.length})`);
say(push.every((r) => r.endsWith(` origin ${ns}/nrt-*)`)), `5 ${ns}: every named-branch push allow rule is ${ns}/nrt-* only`);
JS
}
for ns in feat bajzi; do
  while read -r st msg; do
    case "$st" in PASS) ok "$msg";; *) bad "$msg";; esac
  done < <(render "$ns" 2>&1)
done

nr_summary branch-namespace.sh
