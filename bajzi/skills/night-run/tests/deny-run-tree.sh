#!/usr/bin/env bash
# Proves the PHASE C rules check of SKILL.md refuses a rendered Edit/Write deny
# that covers the run's OWN trees (2026-09-29: `Edit(~/bss-*/**)` matched the
# base worktree ~/bss-night, so story sessions could not write
# runtime/AUTOPILOT-REPORT.md or runtime/handoff/). It runs the very snippet
# SKILL.md ships (extracted, not copied) on the shipped template, rendered with
# a sample BASE / NIGHT_DIR. No claude runs and nothing outside $NR_SCRATCH is
# touched; the rendered JSON and check output go to a scratch dir it recreates.
# Since 1.15.0 it also runs the PHASE C post-render step (extracted the same way)
# and proves: repo-relative Edit/Read denies are mirrored into <NIGHT_DIR>/wt/*/
# (MISSING WT MIRROR / WT PATH NOT DENIED when not), wt/S1/src/index.ts stays
# editable, .env.example is never denied while .env/.env.local are, the
# NIGHT-RULES section-7 docker choice (DOCKER RULE MISMATCH), the never-stop name parser
# (NEVER-STOP NAME UNPARSEABLE), the glm/worker allows, and the supervisor's settings file
# (supset.js, called by PHASE C: the night settings minus exactly this night's state-file deny).
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

# Git Bash: python is a native Windows program, so MSYS would rewrite the POSIX BASE/NIGHT
# arguments and python's '~' would be USERPROFILE. Pin both to the POSIX $HOME form and hand
# python native file names instead. On Linux there is no cygpath and both variables are inert.
nat(){ if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
py(){ MSYS_NO_PATHCONV=1 USERPROFILE=$HOME python3 "$@"; }

# The rules-check snippet: the heredoc body under the `python3 - <settings> ...` line.
sed -n "/^python3 - .*settings\.local\.json.*<<'PY'/,/^PY\$/p" "$SKILL" | sed '1d;$d' >"$T/check.py"
for msg in 'UNRENDERED RULE' 'DENY COVERS RUN TREE' 'MISSING WT MIRROR' 'WT PATH NOT DENIED' 'DOCKER RULE MISMATCH' \
           'NEVER-STOP NAME UNPARSEABLE'; do
  grep -q "$msg" "$T/check.py" || { echo "check.py lacks: $msg"; false; }
done
check $? "SKILL.md PHASE C rules-check snippet found, with all six messages"
# The post-render step (worktree mirrors + section-7 docker choice): the heredoc under `<<'POST'`.
sed -n "/^python3 - .*<<'POST'\$/,/^POST\$/p" "$SKILL" | sed '1d;$d' >"$T/post.py"
[ -s "$T/post.py" ]; check $? "SKILL.md PHASE C post-render snippet found"
# The helpers both snippets import (docker choice, mirror shape): the heredoc under `cat > ...nr_rules.py <<'NRLIB'`.
sed -n "/^cat > .*nr_rules\.py <<'NRLIB'\$/,/^NRLIB\$/p" "$SKILL" | sed '1d;$d' >"$T/nr_rules.py"
[ -s "$T/nr_rules.py" ] && grep -q 'from nr_rules import' "$T/post.py" && grep -q 'from nr_rules import' "$T/check.py" \
  && ! grep -qE 'def (docker|mirror)|container prefix' "$T/post.py" "$T/check.py"
check $? "SKILL.md shared nr_rules.py heredoc found; post and check import it and copy no parser"

# NIGHT-RULES fixtures: section 3 holds the rules the section-3 tests add, section 7 the docker choice.
rules(){ # <file> <section-7 docker line, or '' for none> [section-7 never-stop names, default none]
  printf '# bss night run rules\n\n## 3. Forbidden paths\n\n- `apps/admin/.env.local`, `apps/admin/src/auth*.ts`\n\n## 7. Machine neighbours\n\n- Never stop or restart: %s\n%s\n\n## 8. Resource floors\n\n- none\n' "${3:-none}" "$2" >"$T/$1"
}
rules denied.md '- docker: `denied`' '`prod-db`, `bss-backend`'
rules allowed.md '- docker: `allowed, container prefix bss-sandbox`' '`prod-db`, `bss-backend`'
rules nodocker.md ''
RULES=denied.md   # the NIGHT-RULES file the post step reads; the check reads ${CHECK_RULES:-$RULES}

render(){ # <out> [extra deny rule...]: substitute the config.env values, drop what PHASE C fills or deletes,
          # add the section-3 lines, run the SKILL.md post-render step, then drop $DROP (one rule) if set
  local out=$1; shift
  (cd "$T" && py - "$(nat "$TMPL")" "$out" "$BASE" "$NIGHT" "$@" <<'PY'
import json, re, sys
tmpl, out, base, night = sys.argv[1:5]
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
d["permissions"]["deny"] += [x for x in sys.argv[5:] if x]
json.dump(d, open(out, "w"))
PY
  ) || return
  (cd "$T" && py - "$out" "$NIGHT" "$RULES" <post.py >"$out.post" 2>&1) || return
  [ -z "${DROP:-}" ] || (cd "$T" && py -c "import json,sys;f=sys.argv[1];d=json.load(open(f));d['permissions']['deny'].remove(sys.argv[2]);json.dump(d,open(f,'w'))" "$out" "$DROP")
}

run_check(){ # <name> [extra deny rule...] -> $T/<name>.out, rc in $RC
  local n=$1; shift
  render "$n.json" "$@" || { RC=99; return; }
  (cd "$T" && py - "$n.json" "$BASE" "$NIGHT" "${CHECK_RULES:-$RULES}" <check.py >"$n.out" 2>&1); RC=$?
}
denies(){ # <name> <Edit|Read|Edit|Read> <path>: rc 0 if a deny of that kind in $T/<name>.json covers <path>,
          # judged by check.py's own matcher (rx/path/up), so the probe and the check cannot drift apart
  (cd "$T" && PK=$2 PP=$3 py - "$1.json" "$BASE" "$NIGHT" <<'PY'
import contextlib, io, os, re
ns = {}
with contextlib.redirect_stdout(io.StringIO()):
    try:
        exec(open("check.py").read(), ns)
    except SystemExit:
        pass
rule = re.compile(r"(?:%s)\((.*)\)" % os.environ["PK"])
raise SystemExit(0 if any((m := rule.fullmatch(r)) and any(ns["rx"](ns["path"](m[1])).match(a) for a in ns["up"](os.environ["PP"]))
                          for r in ns["perms"].get("deny", [])) else 1)
PY
  )
}
bash_denied(){ # <name> <command>: rc 0 if a Bash(...) deny in $T/<name>.json matches <command>, with the measured
               # Bash-rule semantics (anchored, every '*' is '.*' and crosses spaces, ':*' = ' *', the rest literal)
  (cd "$T" && py - "$1.json" "$2" <<'PY'
import json, re, sys
def rx(b):
    b = b[:-2] + " *" if b.endswith(":*") else b
    return re.compile(".*".join(map(re.escape, b.split("*"))) + r"\Z", re.S)
deny = [m[1] for r in json.load(open(sys.argv[1]))["permissions"]["deny"] if (m := re.fullmatch(r"Bash\((.*)\)", r))]
raise SystemExit(0 if any(rx(b).match(sys.argv[2]) for b in deny) else 1)
PY
  )
}
post(){ # <file> <NIGHT-RULES fixture>: re-run the SKILL.md post-render step on an already rendered $T/<file>
  (cd "$T" && py - "$1" "$NIGHT" "$2" <post.py >/dev/null 2>&1)
}
has(){ # <name> <allow|deny> <rule>: rc 0 if the rendered $T/<name>.json lists <rule> under permissions.<allow|deny>
  (cd "$T" && py -c "import json,sys;sys.exit(0 if sys.argv[3] in json.load(open(sys.argv[1]))['permissions'][sys.argv[2]] else 1)" "$1.json" "$2" "$3")
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
expect_fail dirform 'Edit(~/bss-*)' 'DENY COVERS RUN TREE: Edit(~/bss-*)' \
  "a directory-form deny without /** (~/bss-*) fails"
expect_fail dirrt 'Edit(~/bss-night/runtime)' 'DENY COVERS RUN TREE: Edit(~/bss-night/runtime)' \
  "Edit(<BASE>/runtime) (directory, no /**) fails"
expect_fail dirslash 'Edit(~/bss-night/runtime/)' 'DENY COVERS RUN TREE: Edit(~/bss-night/runtime/)' \
  "Edit(<BASE>/runtime/) (trailing slash) fails"
expect_fail dotrel 'Edit(./runtime/**)' 'DENY COVERS RUN TREE: Edit(./runtime/**)' \
  "Edit(./runtime/**) (./ form) fails"
expect_fail anydepth 'Edit(handoff/)' 'DENY COVERS RUN TREE: Edit(handoff/)' \
  "a slash-less Edit(handoff/) matches at any depth and fails"
expect_fail anymd 'Edit(*.md)' 'DENY COVERS RUN TREE: Edit(*.md)' \
  "a slash-less Edit(*.md) matches at any depth and fails"
expect_fail decrel 'Edit(runtime/DECISIONS.md)' 'DENY COVERS RUN TREE: Edit(runtime/DECISIONS.md)' \
  "Edit(runtime/DECISIONS.md) fails"
expect_fail decany 'Edit(DECISIONS.md)' 'DENY COVERS RUN TREE: Edit(DECISIONS.md)' \
  "a slash-less Edit(DECISIONS.md) fails"
expect_fail hoglob 'Edit(runtime/handoff/night-*.md)' 'DENY COVERS RUN TREE: Edit(runtime/handoff/night-*.md)' \
  "Edit(runtime/handoff/night-*.md) (the real handoff names) fails"
expect_fail range 'Edit(~/bss-[a-z]*/**)' 'DENY COVERS RUN TREE: Edit(~/bss-[a-z]*/**)' \
  "a bracket range covering the base (~/bss-[a-z]*/**) fails"
expect_pass range2 'Edit(~/bss-[x-z]*/**)' "a bracket range that excludes the base (~/bss-[x-z]*/**) passes"
expect_pass negrange 'Edit(~/bss-[!n]*/**)' "a negated range that excludes the base (~/bss-[!n]*/**) passes"
expect_pass anchored 'Edit(/handoff)' "an anchored Edit(/handoff) is BASE-root only and passes"
expect_pass otherdir 'Edit(secrets/)' "a slash-less directory not on the run paths (secrets/) passes"
expect_pass sibling 'Edit(~/bss-other/**)' "a sibling tree (~/bss-other/**) passes"
expect_pass deeper  'Edit(~/bss-*/secrets/**)' "a narrower protected subtree (~/bss-*/secrets/**) passes"
expect_pass etc     'Edit(//etc/**)'         "a rule outside the run trees (//etc/**) passes"
expect_pass read    'Read(~/bss-*/**)'       "a Read deny is not an edit deny and passes"

# The old check must still fire on a leftover placeholder.
run_check leftover 'Edit(<one Edit line per forbidden path>)'
[ "$RC" -eq 1 ] && grep -qxF 'UNRENDERED RULE: Edit(<one Edit line per forbidden path>)' "$T/leftover.out"
check $? "an unrendered placeholder rule still fails"

# --- (A) section-3 denies must reach the story worktrees <NIGHT_DIR>/wt/<id>/ -----------------
WT="//${NIGHT#/}/wt/*"           # the mirror prefix as rendered: '//' + NIGHT_DIR without its leading '/'
S3A='Edit(apps/admin/.env.local)'; S3B='Edit(apps/admin/src/auth*.ts)'
S3C='Edit(apps/admin/src/middleware.ts)'   # wildcard-free and covered by no template rule, for the probe
expect_pass_n(){ # <name> <description> <extra deny rule...>
  local n=$1 d=$2; shift 2
  run_check "$n" "$@"; [ "$RC" -eq 0 ] && [ ! -s "$T/$n.out" ]; check $? "$d"
}
expect_pass_n s3 "section-3 rules (wildcard-free and wildcard) with their worktree mirrors pass" "$S3A" "$S3B" "$S3C"
has s3 deny "Edit($WT/apps/admin/.env.local)"; check $? "the wildcard-free section-3 rule is mirrored to wt/*/"
has s3 deny "Edit($WT/apps/admin/src/auth*.ts)"; check $? "the wildcard section-3 rule is mirrored to wt/*/"
has s3 deny "Edit($WT/.github/**)" && has s3 deny "Read($WT/**/.env)"
check $? "the template's own repo-relative Edit/Read denies are mirrored too"
denies s3 Edit "$NIGHT/wt/S1/apps/admin/.env.local"; check $? "wt/S1/apps/admin/.env.local is Edit-denied"
denies s3 Edit "$NIGHT/wt/S1/apps/admin/src/auth-x.ts"; check $? "wt/S1/apps/admin/src/auth-x.ts is Edit-denied"
! denies s3 Edit "$NIGHT/wt/S1/src/index.ts"; check $? "wt/S1/src/index.ts stays editable"
DROP="Edit($WT/apps/admin/src/middleware.ts)" run_check s3drop "$S3A" "$S3B" "$S3C"
[ "$RC" -eq 1 ] && grep -qxF "MISSING WT MIRROR: $S3C" "$T/s3drop.out"
check $? "a removed mirror fails with MISSING WT MIRROR: $S3C"
grep -qxF "WT PATH NOT DENIED: $S3C -> $NIGHT/wt/S1/apps/admin/src/middleware.ts" "$T/s3drop.out"
check $? "a removed mirror of a wildcard-free rule fails the worktree probe (WT PATH NOT DENIED)"
DROP="Edit($WT/apps/admin/src/auth*.ts)" run_check s3dropw "$S3A" "$S3B" "$S3C"
[ "$RC" -eq 1 ] && grep -qxF "MISSING WT MIRROR: $S3B" "$T/s3dropw.out" && ! grep -q 'WT PATH NOT DENIED' "$T/s3dropw.out"
check $? "a removed wildcard mirror fails with MISSING WT MIRROR only (wildcard globs are not probed)"
DROP="Edit($WT/.github/**)" run_check s3dropt
[ "$RC" -eq 1 ] && grep -qxF 'MISSING WT MIRROR: Edit(.github/**)' "$T/s3dropt.out"
check $? "a removed mirror of a template rule fails with MISSING WT MIRROR: Edit(.github/**)"
expect_pass_n dotrel2 "a './' section-3 rule is mirrored without its './'" 'Read(./secrets/key.pem)'
has dotrel2 deny "Read($WT/secrets/key.pem)"; check $? "Read(./secrets/key.pem) -> Read($WT/secrets/key.pem)"
expect_pass_n anyd "a slash-less section-3 rule (secrets.json) passes with its any-depth mirror" 'Edit(secrets.json)'
has anyd deny "Edit($WT/**/secrets.json)"; check $? "Edit(secrets.json) -> Edit($WT/**/secrets.json): it keeps matching at any depth"
denies anyd Edit "$NIGHT/wt/S1/apps/x/secrets.json"; check $? "nested wt/S1/apps/x/secrets.json is Edit-denied"
DROP="Edit($WT/**/secrets.json)" run_check anyddrop 'Edit(secrets.json)' "Edit($WT/secrets.json)"
[ "$RC" -eq 1 ] && grep -qxF "WT PATH NOT DENIED: Edit(secrets.json) -> $NIGHT/wt/S1/apps/x/secrets.json" "$T/anyddrop.out"
check $? "a root-only mirror of a slash-less rule fails the nested worktree probe (WT PATH NOT DENIED)"
expect_fail srcdeny 'Edit(src/**)' "DENY COVERS RUN TREE: Edit($WT/src/**)" \
  "a section-3 rule whose mirror covers wt/S1/src/index.ts fails"

# --- (B) .env.example stays readable and editable, .env and .env.local do not -----------------
for p in "$BASE/.env.example" "$BASE/apps/admin/.env.example" "$NIGHT/wt/S1/.env.example" "$NIGHT/wt/S1/apps/admin/.env.example"; do
  ! denies base 'Edit|Read' "$p"; check $? "no rendered Read/Edit deny covers ${p#"$HOME"/}"
done
for p in "$BASE/.env" "$BASE/apps/admin/.env.local" "$NIGHT/wt/S1/.env" "$NIGHT/wt/S1/apps/admin/.env.local" \
         "$BASE/.env.production" "$BASE/.env.development.local" "$NIGHT/wt/S1/apps/admin/.env.staging" "$NIGHT/wt/S1/.env.test"; do
  denies base Read "$p" && denies base Edit "$p"; check $? "${p#"$HOME"/} is Read- and Edit-denied"
done

(cd "$T" && py -c "import json,sys;p=json.load(open('base.json'))['permissions'];sys.exit(any('[!' in r for r in p['allow'] + p['deny']))")
check $? "no rendered rule uses a [!...] class (measured inverted on Claude Code 2.1.288)"

# --- (C) docker: NIGHT-RULES section 7 decides --------------------------------------------------
BLANKET=('Bash(*docker *)' 'Bash(*docker-compose*)')
SCOPED=('Bash(docker ps*)' 'Bash(docker logs bss-sandbox-*)' 'Bash(docker exec bss-sandbox-*)'
        'Bash(docker restart bss-sandbox-*)' 'Bash(docker run --rm --name night-*)' 'Bash(docker rm -f night-*)'
        'Bash(docker compose -p night-* *)' 'Bash(docker build *)' 'Bash(docker pull *)')
RULES=allowed.md expect_pass_n dalw "docker allowed: the render passes the rules check"
ok_=0; for r in "${SCOPED[@]}"; do has dalw allow "$r" || { echo "  missing allow: $r"; ok_=1; }; done
check $ok_ "docker allowed: all nine scoped allows rendered with the container prefix"
! has dalw deny "${BLANKET[0]}" && ! has dalw deny "${BLANKET[1]}"
check $? "docker allowed: no blanket docker deny left"
NEVER=('Bash(*docker*prod-db*)' 'Bash(*docker*bss-backend*)')
GUARD=('Bash(*docker*-v *)' 'Bash(*docker*--volume*)' 'Bash(*docker*--mount*)' 'Bash(*docker*--privileged*)'
       'Bash(*docker*docker.sock*)' 'Bash(*docker*prune*)')
ok_=0; for r in "${NEVER[@]}" "${GUARD[@]}"; do has dalw deny "$r" || { echo "  missing deny: $r"; ok_=1; }; done
check $ok_ "docker allowed: one deny per section-7 never-stop name plus the mount/privileged/socket/prune denies"
for c in 'docker rm -f night-x prod-db' 'docker restart bss-sandbox-a prod-db' 'docker exec bss-sandbox-a docker stop bss-backend' \
         'docker run --rm --name night-x -v /:/host alpine' 'docker run --rm --name night-x --privileged alpine' \
         'docker run --rm --name night-x --mount type=bind,src=/,dst=/h alpine' 'docker exec bss-sandbox-a ls /var/run/docker.sock' \
         'docker system prune -af'; do
  bash_denied dalw "$c"; check $? "docker allowed: '$c' is denied"
done
for c in 'docker logs bss-sandbox-web' 'docker restart bss-sandbox-web' 'docker run --rm --name night-x alpine true'; do
  ! bash_denied dalw "$c"; check $? "docker allowed: '$c' is not denied"
done
RULES=allowed.md DROP="${NEVER[0]}" run_check dmis3
[ "$RC" -eq 1 ] && grep -qxF "DOCKER RULE MISMATCH: docker allowed in section 7, rule missing: ${NEVER[0]}" "$T/dmis3.out"
check $? "section 7 allowed but a never-stop deny missing fails with DOCKER RULE MISMATCH"
grep -qxF "DOCKER RULE MISMATCH: docker allowed in section 7, never-stop name not denied: docker rm -f night-x prod-db" "$T/dmis3.out" \
  && grep -qxF "DOCKER RULE MISMATCH: docker allowed in section 7, never-stop name not denied: docker restart bss-sandbox-a prod-db" "$T/dmis3.out"
check $? "the check probes each never-stop name (docker rm -f night-x / docker restart <prefix>-a), not only rule presence"
# Never-stop names: every backticked token, else a plain item's single word; notes in parentheses dropped.
rules plain.md '- docker: `allowed, container prefix bss-sandbox`' 'prod-db (postgres), redis'
RULES=plain.md expect_pass_n dplain "plain-text never-stop line 'prod-db (postgres), redis': the render passes the rules check"
for c in 'docker rm -f night-x prod-db' 'docker restart bss-sandbox-a redis'; do
  bash_denied dplain "$c"; check $? "plain-text never-stop line: '$c' is denied"
done
! has dplain deny 'Bash(*docker*prod-db (postgres)*)'; check $? "plain-text never-stop line: the note is not part of the name"
rules span.md '- docker: `allowed, container prefix bss-sandbox`' '`prod-db, redis` (one backtick span)'
RULES=span.md expect_pass_n dspan "a single backtick span '\`prod-db, redis\`' passes the rules check"
bash_denied dspan 'docker rm -f night-x prod-db' && bash_denied dspan 'docker restart bss-sandbox-a redis'
check $? "a single backtick span still denies both names"
rules ticknote.md '- docker: `allowed, container prefix bss-sandbox`' 'prod-db (`postgres`, main), redis.'
RULES=ticknote.md expect_pass_n dticknote "a backtick inside a (note) does not replace the name: the render passes"
bash_denied dticknote 'docker rm -f night-x prod-db' && bash_denied dticknote 'docker restart bss-sandbox-a redis' \
  && ! has dticknote deny 'Bash(*docker*postgres*)' && ! has dticknote deny 'Bash(*docker*main*)'
check $? "'prod-db (\`postgres\`, main), redis.': prod-db and redis denied, nothing from the note"
rules wiki.md '- docker: `allowed, container prefix bss-sandbox`' '`prod-db`, (see wiki)'
RULES=wiki.md run_check dwiki
[ "$RC" -eq 1 ] && grep -qxF 'NEVER-STOP NAME UNPARSEABLE: (see wiki)' "$T/dwiki.out"
check $? "an item with no valid name fails with NEVER-STOP NAME UNPARSEABLE: (see wiki)"
NS=$(sed -n 's/^- Never stop or restart: //p' "$NR_SKILL_DIR/templates/NIGHT-RULES.md.tmpl")   # the shipped placeholder
rules unfilled.md '- docker: `allowed, container prefix bss-sandbox`' "$NS"
RULES=unfilled.md run_check dunfilled
[ "$RC" -eq 1 ] && grep -qxF 'NEVER-STOP NAME UNPARSEABLE: `<name>` (<optional note>)' "$T/dunfilled.out"
check $? "the unfilled template placeholder fails with NEVER-STOP NAME UNPARSEABLE"
# Every backticked token is a name, in any separator form; a plain item must be one name (plus an optional note).
i=0; for ns in '`prod-db` `redis`' '`prod-db` / `redis`' '`prod-db` and `redis`.'; do
  i=$((i+1)); rules "multi$i.md" '- docker: `allowed, container prefix bss-sandbox`' "$ns"
  RULES=multi$i.md expect_pass_n "dmulti$i" "never-stop item '$ns': the render passes the rules check"
  bash_denied "dmulti$i" 'docker rm -f night-x prod-db' && bash_denied "dmulti$i" 'docker restart bss-sandbox-a redis'
  check $? "never-stop item '$ns': both prod-db and redis are denied"
done
i=0; for ns in 'main postgres db' 'prod-db / redis' '`prod-db` redis' '`none` redis'; do
  i=$((i+1)); rules "plainbad$i.md" '- docker: `allowed, container prefix bss-sandbox`' "\`ok-db\`, $ns"
  RULES=plainbad$i.md run_check "dplainbad$i"
  [ "$RC" -eq 1 ] && grep -qxF "NEVER-STOP NAME UNPARSEABLE: $ns" "$T/dplainbad$i.out"
  check $? "never-stop item '$ns' fails with NEVER-STOP NAME UNPARSEABLE instead of keeping one word"
done
for f in denied nodocker; do
  RULES=$f.md expect_pass_n "d$f" "docker $f: the render passes the rules check"
  has "d$f" deny "${BLANKET[0]}" && has "d$f" deny "${BLANKET[1]}" && ! grep -q 'Bash(docker' "$T/d$f.json" \
    && ! grep -qF 'Bash(*docker*' "$T/d$f.json"
  check $? "docker $f: both blanket docker denies kept, no docker allow, no added docker deny"
done
RULES=denied.md CHECK_RULES=allowed.md run_check dmis1
[ "$RC" -eq 1 ] && grep -qxF "DOCKER RULE MISMATCH: docker allowed in section 7, blanket deny still rendered: ${BLANKET[0]}" "$T/dmis1.out"
check $? "section 7 allowed but the blanket deny rendered fails with DOCKER RULE MISMATCH"
RULES=allowed.md CHECK_RULES=denied.md run_check dmis2
[ "$RC" -eq 1 ] && grep -qxF "DOCKER RULE MISMATCH: docker denied in section 7, docker allow rendered: ${SCOPED[0]}" "$T/dmis2.out"
check $? "section 7 denied but a docker allow rendered fails with DOCKER RULE MISMATCH"

# The post step is idempotent and reversible on ONE file: allowed twice = once, allowed -> denied restores the
# blanket denies and drops everything allowed added, denied -> allowed again = the first allowed file.
RULES=allowed.md render rev.json && cp "$T/rev.json" "$T/rev1.json"
post rev.json allowed.md && cmp -s "$T/rev.json" "$T/rev1.json"; check $? "docker allowed re-run gives the same file"
post rev.json denied.md
has rev deny "${BLANKET[0]}" && has rev deny "${BLANKET[1]}" && ! grep -qF 'Bash(docker' "$T/rev.json" && ! grep -qF 'Bash(*docker*' "$T/rev.json"
check $? "allowed then denied: blanket denies back, scoped allows and added docker denies gone"
(cd "$T" && py - rev.json "$BASE" "$NIGHT" denied.md <check.py >rev.out 2>&1) && [ ! -s "$T/rev.out" ]
check $? "allowed then denied: the rules check returns 0"
post rev.json allowed.md && cmp -s "$T/rev.json" "$T/rev1.json"; check $? "denied then allowed again gives the first allowed file"

# NIGHT-RULES section 7 tells the owner what `allowed` really opens, at the point of choosing.
S7=$(sed -n '/^## 7\./,/^## 8\./p' "$NR_SKILL_DIR/templates/NIGHT-RULES.md.tmpl" | tr '\n' ' ' | tr -s ' ')
ok_=0
for w in 'root-equivalent' 'any later arguments' 'volume mount' 'every Edit and Read deny' 'pattern guard, not a security boundary' 'compose file'; do
  grep -qiF "$w" <<<"$S7" || { echo "  NIGHT-RULES section 7 lacks: $w"; ok_=1; }
done
check $ok_ "NIGHT-RULES section 7 warns that docker is root-equivalent and exec/run take any arguments incl. mounts"
ok_=0
for w in 'in backticks' 'comma-separated' 'note after the name in parentheses' 'NEVER-STOP NAME UNPARSEABLE'; do
  grep -qiF "$w" <<<"$S7" || { echo "  NIGHT-RULES section 7 lacks: $w"; ok_=1; }
done
check $ok_ "NIGHT-RULES section 7 tells the owner the never-stop name format"

# --- (D) saver-level allows --------------------------------------------------------------------
has base allow 'Bash(glm *)' && has base allow 'Bash(worker --usage*)' && has base allow 'Bash(worker --status*)'
check $? "the glm / worker --usage / worker --status allows are rendered"

# --- (E) the supervisor's own settings: the night file minus THIS night's state-file deny ----------
# The supervisor re-queues a story by deleting its state row, which Edit(~/night-runs/<project>/state*.txt)
# forbids; PHASE C (and supervise.sh at every tick) renders <NIGHT_DIR>/supervise.settings.json without
# that one rule through supset.js.
SUPSET_JS=$(nat "$NR_SKILL_DIR/supset.js")
sup(){ MSYS_NO_PATHCONV=1 HOME=$HOME USERPROFILE=$HOME node "$SUPSET_JS" "$@"; }
grep -q '^node "${CLAUDE_PLUGIN_ROOT%/}/skills/night-run/supset.js" [^ ]*/settings\.local\.json <NIGHT_DIR> <NIGHT_DIR>/supervise\.settings\.json$' "$SKILL" \
  && grep -qF 'echo "supset rc=$?"' "$SKILL" && ! grep -q "<<'SUPSET'" "$SKILL"
check $? "SKILL.md PHASE C writes the supervisor settings with supset.js (no SUPSET heredoc copy)"
OTHER='Edit(~/night-runs/other/state*.txt)'
render sup.json "$OTHER"
(cd "$T" && sup sup.json "$NIGHT" supout.json >sup.out 2>&1); check $? "supset.js exits 0 on the rendered night settings"
(cd "$T" && py - sup.json supout.json <<'PY'
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
a["permissions"]["deny"].remove("Edit(~/night-runs/bss/state*.txt)")
sys.exit(0 if a == b else 1)
PY
); check $? "supervise.settings.json = the night settings minus exactly Edit(~/night-runs/bss/state*.txt), all else identical"
has supout deny "$OTHER"; check $? "another night dir's state deny stays in the supervisor file"
DROP='Edit(~/night-runs/bss/state*.txt)' render nostate.json
(cd "$T" && sup nostate.json "$NIGHT" nostateout.json >nostate.out 2>&1); [ $? -ne 0 ] && [ ! -e "$T/nostateout.json" ]
check $? "a night settings file without this night's state deny makes supset.js fail and write nothing"

nr_summary deny-run-tree
