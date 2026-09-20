#!/usr/bin/env bash
# worktree-cleanup.sh — morning (PHASE F) cleanup of a night run's worktrees.
# Shared by every project, never edited per project: all facts come from the
# same config.env the runner uses (templates/config.env.tmpl).
#
# Usage:
#   worktree-cleanup.sh --config <path/to/config.env> [--apply] [--no-fetch] [--prune]
#   (--config <path> or --config=<path>; NIGHT_CONFIG is used when neither is
#   given. `--help` prints the same usage block and the exit-status table.)
#
#   (no flag)   DRY RUN — decides and prints, removes NOTHING. The default.
#   --apply     actually run `git worktree remove` for the trees decided REMOVE.
#   --no-fetch  skip the `git fetch` that refreshes origin/* before judging.
#               Every rule is still evaluated normally, against the refs already
#               on disk, and the REAL verdict is printed — but a removal verdict
#               is labelled WOULD-REMOVE (unverified) and the run is FORCED to a
#               dry run, so nothing is ever removed under --no-fetch. The flag
#               used to KEEP every tree, which printed N identical lines and was
#               indistinguishable from a totally broken run. `--no-fetch` with
#               `--apply` or with `--prune` is a contradiction and is rejected
#               with exit 2 before any repository is touched: without refreshed
#               refs "pushed"/"merged" cannot be proven, so nothing may be
#               removed and nothing may be de-registered.
#   --prune     ALSO run `git worktree prune` in the repos we removed from.
#               OFF by default and rarely wanted: prune is REPO-WIDE, not
#               per-project, and de-registers every worktree of that repo whose
#               directory it cannot see — including another project's live tree.
#               A successful `git worktree remove` already cleans up after
#               itself, so this is only for a repo with known-stale metadata.
#
# It reads $NIGHT_DIR/worktrees.tsv (<id> TAB <path> TAB <branch> TAB <created
# ISO>) and touches NOTHING that is not listed there, even if a sibling path
# looks like a night worktree. Two real incidents shaped this file: 18 stale
# trees piled up when they lived loose in $HOME, and a tidy-up session destroyed
# four uncommitted files in a tree it removed. Leaving a directory on disk is
# strictly cheaper than losing work, so every check below fails towards KEEP.
#
# Decision order per recorded tree — stop at the FIRST rule that says KEEP:
#   1. a live process is using the tree (cwd inside it, or a story session for
#      its id/branch still running)                                    -> KEEP
#   1b. the story is PARKED or BLOCKED per state.txt / the night report -> KEEP
#   2a. the repo could not be located, or `git fetch origin` failed      -> KEEP
#   2. `git rev-parse --verify origin/<branch>` exits non-zero          -> KEEP
#   3. dirty (`git status --porcelain --ignored=matching`) or unpushed
#      (`git cherry -v origin/<branch> HEAD` lists `+` commits)         -> KEEP
#   4. no MERGED PR for the branch                                      -> KEEP
#   5. everything above passed -> re-run rule 3's status check, then
#      `git worktree remove <path>`, never --force.
#
# Rules 3 and 4 are REPORTED in that order but EXECUTED the other way round:
# rule 4 is a network round trip, and while it was the last thing before the
# removal, anything written into the tree during it was destroyed. The gh call
# now happens first, rule 3 is re-run immediately before the removal, and the
# reported reason (and with it the exit code) keeps the order above.
#
# EVERY git/gh call above is judged on its EXIT CODE first and its output
# second. A failed command prints nothing, and "no output" read as "nothing
# wrong" is how this tool destroys work: `git status --porcelain
# --ignored=matching` exits 128 with zero bytes on stdout when
# status.showUntrackedFiles=no is set anywhere in the config chain, and
# `git cherry -v origin/<missing-branch>` does the same. So: non-zero exit from
# any safety check means the check COULD NOT BE COMPLETED, which means KEEP.
#
# `git worktree remove` without --force is NOT a backstop, but the precise shape
# of what it does and does not refuse matters — an overstated safety note is how
# the original bug survived review once already. Measured on git 2.43.0:
#   - modified TRACKED files      -> refused, "contains modified or untracked
#                                    files, use --force", exit 128, tree lives;
#   - plain UNTRACKED files       -> refused the same way, exit 128, tree lives;
#   - GITIGNORED content only
#     (the local .env)            -> DELETED, exit 0, file gone;
#   - anything, with
#     status.showUntrackedFiles=no -> its internal check is silenced, so even
#                                    untracked files are DELETED, exit 0.
# So it covers two of the four cases and the two it misses are exactly the
# unrecoverable ones. Rule 3 — our own status call, with its exit code checked —
# is the only guard that covers all four.
#
# Exit status:
#   0  nothing kept that the owner has to look at
#   1  at least one tree was kept dirty, unpushed, parked or blocked
#   2  usage / config error
#
# NEVER deletes a branch — merged branches are printed as a suggestion for the
# owner, who decides with the PR in front of them.

set -u

# ---------------------------------------------------------------- arguments --
# THE DESTRUCTIVE MODES CAN ONLY BE TURNED ON BY A LITERAL FLAG IN THIS argv.
# Nothing a file can write — config.env, the environment, anything the config
# sources — reaches APPLY / FETCH / PRUNE. These are NOT three interchangeable
# defences: one is the guarantee, the others are isolation and belt.
#   1. THE GUARANTEE: config.env is sourced in a SEPARATE PROCESS and what comes
#      back is PARSED, NEVER EXECUTED — NUL-terminated name=value records, of
#      which only PROJECT / NIGHT_DIR / REPO / GH_BIN are assigned; every other
#      name, and every record carrying no `=` at all, is discarded. Those four
#      are the config's own fields, so even a fully forged stream gains the file
#      nothing. This is the only mechanism that holds on its own. Whether the
#      config RAN TO ITS END is a separate question, answered by the child
#      PROCESS'S EXIT STATUS — never by a record inside the stream.
#   2. ISOLATION: the sourcing happens in another process, so nothing the file
#      assigns, unsets, marks readonly or defines as a function exists in this
#      shell at all. That is what lets 1 be a four-name whitelist instead of a
#      hunt for every name a config might abuse.
#   3. BELT: APPLY / FETCH / PRUNE are hard-reset to their SAFE defaults
#      (0 / 1 / 0) AFTER the config has been read and re-derived by re-scanning
#      the saved literal argv, so whatever anything set in between is
#      overwritten. Cheap, and independent of 1 and 2 — but on its own it only
#      covers the names it re-derives.
# The history that earns all three: the sourcing once happened AFTER this loop,
# so an `APPLY=1` line in the config made a bare, flagless invocation remove
# trees and a `PRUNE=1` line made it run a REPO-WIDE prune — the one way --prune
# could fire without the flag, in a repo the night runner shares with other
# projects' live worktrees. Moving the sourcing up only pushed the hole one
# level deeper: the re-assertion then read CLI_APPLY / CLI_PRUNE / CLI_FETCH,
# names a config file can assign just as easily, and a config carrying
# `CLI_APPLY=1 CLI_PRUNE=1` still produced a flagless repo-wide prune. The third
# reopening was subtler: the child's import stream was `eval`ed, so a config
# defining a `printf` function wrote the stream itself and ran a `trap ... DEBUG`
# in THIS shell — flagless APPLY plus a repo-wide prune again, from a file that
# never assigned a single one of the guarded names. "A cleanup tool that deletes
# by default is a bug", so the gating cannot be a convention about which names
# the template avoids, nor a hope that the child's builtins are still the real
# ones: what the config produces is DATA, and the whitelist parse is where that
# is enforced.
ARGV_LITERAL=("$@")
CONFIG=${NIGHT_CONFIG:-}
CLI_APPLY=0
CLI_FETCH=1
CLI_PRUNE=0
usage(){
  cat >&2 <<'USAGE'
Usage:
  worktree-cleanup.sh --config <path/to/config.env> [--apply] [--no-fetch] [--prune]

  --config <path>   the run's config.env; --config=<path> works too. Without it
                    the NIGHT_CONFIG environment variable is used.
  (no flag)         DRY RUN — decides and prints, removes NOTHING. The default.
  --apply           actually run `git worktree remove` for the REMOVE rows.
  --no-fetch        do not refresh origin/*. Every rule is still evaluated
                    against the refs already on disk and the real verdict is
                    printed, but a removal verdict is labelled
                    WOULD-REMOVE (unverified) and the run is forced to a dry
                    run. Rejected together with --apply or --prune (exit 2).
  --prune           ALSO run `git worktree prune` in the repos we removed from.
                    OFF by default: prune is REPO-WIDE and de-registers every
                    worktree of that repo whose directory it cannot see,
                    including another project's live tree. A successful
                    `git worktree remove` already cleans up after itself.
  -h, --help        print this and exit 0.

Exit status:
  0  nothing kept that the owner has to look at
  1  at least one tree was kept dirty, unpushed, parked or blocked
  2  usage / config error
USAGE
}
while [ $# -gt 0 ]; do
  case "$1" in
    --config)   [ $# -ge 2 ] || { echo "worktree-cleanup.sh: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    --config=*) CONFIG=${1#--config=}; [ -n "$CONFIG" ] || { echo "worktree-cleanup.sh: --config= needs a path" >&2; exit 2; };;
    --apply)    CLI_APPLY=1;;
    --no-fetch) CLI_FETCH=0;;
    --prune)    CLI_PRUNE=1;;
    -h|--help)  usage; exit 0;;
    *) echo "worktree-cleanup.sh: unknown argument $1" >&2; usage; exit 2;;
  esac
  shift
done
# Belt on the belt, and NOT a defence against a config: frozen the instant
# parsing ends, so a stray assignment in THIS file is a fatal error rather than a
# silent override. It stops nothing config.env can do — the config is sourced in
# another process and never reaches these names — and the real gating is the
# re-derivation from ARGV_LITERAL below. Kept because it costs nothing and
# catches our own future edits.
readonly CLI_APPLY CLI_FETCH CLI_PRUNE

# Nothing can be removed without a fetch, so combining --no-fetch with a
# destructive flag is an impossible combination, not a run that "kept everything
# for you". It must exit 2 (usage error) and not 1 (trees need your attention)
# — PHASE F branches on exactly that difference. Stale origin/* refs make every
# "pushed" and "merged" judgement unprovable, and an irreversible action taken
# on an unprovable judgement is the entire bug class this file exists to avoid,
# so --prune is refused alongside --apply.
# Checked TWICE: here, so the user is told before anything else happens, and
# again after the config has been read, on the independently re-derived values.
no_fetch_conflict(){ # <fetch> <apply> <prune> — 0 = refuse, message on stderr
  [ "$1" -eq 0 ] || return 1
  if [ "$2" -eq 1 ]; then
    echo "worktree-cleanup.sh: --no-fetch and --apply are mutually exclusive. Without a fetch nothing can be proven pushed or merged, so nothing may be removed; drop one of the two flags." >&2
    return 0
  fi
  if [ "$3" -eq 1 ]; then
    echo "worktree-cleanup.sh: --no-fetch and --prune are mutually exclusive. Without a fetch nothing is removed, and a REPO-WIDE prune on top of a run that proved nothing is never what you meant; drop one of the two flags." >&2
    return 0
  fi
  return 1
}
if no_fetch_conflict "$CLI_FETCH" "$CLI_APPLY" "$CLI_PRUNE"; then exit 2; fi

if [ -z "$CONFIG" ]; then
  echo "worktree-cleanup.sh: no config — pass --config <path/to/config.env> or set NIGHT_CONFIG." >&2
  exit 2
fi
[ -f "$CONFIG" ] || { echo "worktree-cleanup.sh: config file not found: $CONFIG" >&2; exit 2; }

# Mechanism 1 — THE GUARANTEE. config.env is sourced in a SEPARATE bash PROCESS
# and what comes back is PARSED, never executed: NUL-terminated `name=value`
# records, of which this shell assigns ONLY the four facts the config owns
# (PROJECT / NIGHT_DIR / REPO / GH_BIN). Every other name — and every record
# that carries no `=` at all — is DISCARDED. Nothing derived from the config is
# `eval`ed, sourced or run here, so the worst a stream can do is set the four
# fields it was allowed to set anyway.
#
# That whitelist is the guarantee precisely because the stream CANNOT be
# trusted: it is built by the child, after the config has had a chance to
# redefine every builtin the child uses. This code replaced an
# `eval "$CONFIG_IMPORT"` of a `printf %q` stream, under which
#     printf(){ builtin printf '%s\n' ... "trap 'APPLY=1;PRUNE=1' DEBUG"; }
# in a config forged the import, ran ARBITRARY CODE in this shell and turned a
# flagless invocation into an APPLY run with a REPO-WIDE prune.
# `builtin printf` in the child is belt, not braces: it bypasses a config's
# `printf` function so the ordinary hostile file never even shapes the stream —
# but nothing below depends on the child having stayed honest.
#
# The separate process is ISOLATION, not the guarantee: a config that sets
# APPLY, PRUNE, ACT, FETCH, CLI_APPLY or any other name sets it in a process
# that then exits; nothing it assigns, unsets, marks readonly, defines as a
# function or switches on with `set` exists in the deciding shell at all. (A
# plain `( . )` subshell is NOT enough for the reverse direction either: it
# inherits this shell's readonly attributes, so a config merely mentioning
# CLI_APPLY would abort mid-file. A separate process makes the two worlds
# genuinely disjoint.)
#
# "RAN TO ITS END" IS THE CHILD PROCESS'S EXIT STATUS — NEVER A RECORD.
# It used to be an in-band CONFIG_SOURCED=1 marker in the stream, and the marker
# was FORGEABLE: `. "$CFG" >&2` is a redirection ON the source command, so for
# its duration bash parks the child's real stdout on a spare descriptor (fd 10)
# — reachable from the config, which runs in that very shell. A file that did
#     builtin printf 'PROJECT=…\0…\0CONFIG_SOURCED=1\0' >&10
# and then contained a syntax error got the parent to see a full, marked stream,
# believe the config had run to its end and proceed (flagless DRY RUN, exit 0)
# where it had to exit 2. Bytes in a channel the writer can reach are not
# evidence about the writer. So now:
#   - `exec 9>&1 1>&2` runs FIRST and PERMANENTLY, before the config is read.
#     No redirection is left on the `.` command, so bash parks nothing anywhere
#     for the config to find, and everything the file prints lands on this run's
#     stderr.
#   - fd 9 — the collection file — is the only way out, and what travels it is
#     still only DATA, filtered by the four-name whitelist below.
#   - the gate is `cfg_rc`, the exit status of the `bash -c` PROCESS. A syntax
#     error, a `.` that returns non-zero, an unreadable file, a config whose
#     LAST command merely fails: all non-zero, all exit 2 here -- UNLESS the
#     config sets its own exit status first: a `trap 'builtin exit 0' EXIT`
#     installed before the broken line still fires, so cfg_rc reads 0 and the
#     run proceeds on half a config -- but only on the PROJECT / NIGHT_DIR /
#     REPO / GH_BIN it already wrote to fd 9 itself; see the residuals below.
#     `builtin exit 17` and `builtin printf` are used so a config that
#     defines an `exit` function cannot no-op the gate; a config that shadows
#     `builtin` itself silences its own emitter instead, producing no records,
#     which the required-field check below turns into exit 2 just the same.
# The residuals, stated plainly: a config that calls `exit 0` early is
# indistinguishable from one that ran to its end — the child dies before the
# emitter, so it produces NO records and the required-field check rejects it
# with exit 2 ("missing required field(s): PROJECT NIGHT_DIR REPO"). And a
# config can always CLAIM completion (end with `:`, or install an EXIT trap):
# that gains it nothing, because the only thing it can then deliver is its own
# four fields. A config that legitimately ends in a command that may fail must
# end with a `:` line.
#
# `./` prefix: `. -foo.env` would be parsed as an option, and a bare name with
# no slash is a PATH lookup, not the file the caller meant.
case "$CONFIG" in
  /*|./*|../*) CONFIG_SRC=$CONFIG;;
  *)           CONFIG_SRC=./$CONFIG;;
esac
PROJECT=""
NIGHT_DIR=""
REPO=""
GH_BIN=""
cfg_tmp=$(mktemp) || { echo "worktree-cleanup.sh: could not create a temporary file for the config import" >&2; exit 2; }
# Removed on EVERY exit path — the exit-2 branches below included.
trap 'rm -f "$cfg_tmp"' EXIT
# `${!v}` indirect expansion over a HARD-CODED list of four names: the lookup
# needs no `eval`, so not even the emitter re-reads anything as code.
NIGHT_CLEANUP_CFG=$CONFIG_SRC bash -c '
  exec 9>&1 1>&2
  # shellcheck source=/dev/null
  . "$NIGHT_CLEANUP_CFG" || builtin exit 17
  for v in PROJECT NIGHT_DIR REPO GH_BIN; do
    builtin printf "%s=%s\0" "$v" "${!v:-}" >&9
  done
' > "$cfg_tmp" 2>&2
cfg_rc=$?
if [ "$cfg_rc" -ne 0 ]; then
  rm -f "$cfg_tmp"
  echo "worktree-cleanup.sh: $CONFIG could not be read to its end (rc=$cfg_rc — syntax error, it calls exit, it cannot be read, or its last command failed; end it with a ':' line if that is intended) — refusing to run on half a config." >&2
  exit 2
fi
# The records are read from the FILE, once, AFTER the gate has been decided. A
# background grandchild that outlived `bash -c` still holds fd 9, but it cannot
# change the verdict — that was settled by a process exit status — and anything
# it appends can still only land in the same four config-owned fields.
while IFS= read -r -d '' cfg_rec; do
  # No `=` at all is not a `name=value` record: `${cfg_rec%%=*}` would set the
  # NAME to the record's own literal text. Skip it.
  case "$cfg_rec" in *=*) :;; *) continue;; esac
  cfg_name=${cfg_rec%%=*}
  cfg_val=${cfg_rec#*=}
  case "$cfg_name" in
    PROJECT|NIGHT_DIR|REPO|GH_BIN) printf -v "$cfg_name" '%s' "$cfg_val";;
    *) :;;   # not ours to take — including APPLY, PRUNE, ACT, FETCH, CLI_*
  esac
done < "$cfg_tmp"
rm -f "$cfg_tmp"

# Mechanism 3: the destructive modes are derived HERE — after the config, from
# SAFE defaults — by re-scanning the literal argv this process started with.
# The three resets below overwrite anything set in between, so the ONLY way to
# reach APPLY=1 or PRUNE=1 is to have typed the flag in the invocation. This is
# deliberately independent of the CLI_* values: two derivations of the same
# answer, neither of which a file can reach. The skip dance mirrors the parse
# loop's `shift`, so `--config --apply` (a path that happens to spell a flag)
# is not mistaken for the flag itself.
APPLY=0
FETCH=1
PRUNE=0
argv_skip=0
for arg in ${ARGV_LITERAL[@]+"${ARGV_LITERAL[@]}"}; do
  if [ $argv_skip -eq 1 ]; then argv_skip=0; continue; fi
  case "$arg" in
    --config)   argv_skip=1;;
    --apply)    APPLY=1;;
    --no-fetch) FETCH=0;;
    --prune)    PRUNE=1;;
  esac
done
if no_fetch_conflict "$FETCH" "$APPLY" "$PRUNE"; then exit 2; fi
# ACT is the EFFECTIVE apply. --no-fetch hard-forces a dry run here, so no code
# path below can remove a tree judged against refs that were never refreshed —
# belt and braces behind the argument-level rejection above.
ACT=$APPLY
if [ $FETCH -eq 0 ]; then ACT=0; fi

missing=""
for v in PROJECT NIGHT_DIR REPO; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v"
done
[ -n "$missing" ] && { echo "worktree-cleanup.sh: $CONFIG is missing required field(s):$missing" >&2; exit 2; }
[ -d "$NIGHT_DIR" ] || { echo "worktree-cleanup.sh: NIGHT_DIR does not exist: $NIGHT_DIR" >&2; exit 2; }

TSV=$NIGHT_DIR/worktrees.tsv
STATE=$NIGHT_DIR/state.txt
LOGS=$NIGHT_DIR/logs
GH_BIN=${GH_BIN:-gh}
NIGHT_DIR_REAL=$(readlink -f "$NIGHT_DIR" 2>/dev/null || printf '%s' "$NIGHT_DIR")

if [ ! -f "$TSV" ]; then
  echo "worktree-cleanup.sh: no $TSV — this run recorded no worktrees, nothing to clean."
  exit 0
fi

# ------------------------------------------------------------------ helpers --
# Every helper answers "is it safe to remove?" and returns the UNSAFE answer
# whenever it cannot tell (missing tool, unreadable procfs, failing command).

# Rule 1: any process whose cwd sits inside the tree, or a story session one of
# whose ARGV WORDS is the tree or the branch.
#
# `pgrep -f "$branch"` is NOT used and must not come back: -f matches an
# unanchored ERE against the whole flattened command line, so the shell running
# this very check — whose command line contains the path and the branch, because
# they are its arguments — matches itself, and so does any grep, editor or log
# tail that merely mentions the name. Measured: 5 out of 5 runs matched the
# caller's own shell, i.e. the rule-1 verdict was noise. The project already
# solved this for the runner lock (spec section 5): read /proc/<pid>/cmdline,
# split it on NUL and compare WHOLE argv words. A process that merely mentions
# the name has it embedded in a `-c` string, not as an argv word of its own.
tree_in_use(){ # <real path> <branch>
  local path=$1 branch=$2 p pid link word
  # Cannot read procfs -> cannot answer -> answer UNSAFE.
  if [ ! -r /proc/self/cmdline ]; then
    printf 'procfs is not readable, so "is anything using this tree?" cannot be answered'
    return 0
  fi
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "${PPID:-0}" ] && continue
    link=$(readlink "$p/cwd" 2>/dev/null) || continue
    case "$link" in "$path"|"$path"/*) printf 'pid %s has its cwd in the tree' "$pid"; return 0;; esac
  done
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "${PPID:-0}" ] && continue
    [ -r "$p/cmdline" ] || continue
    while IFS= read -r word; do
      case "$word" in
        "$path"|"$path"/*)
          printf 'pid %s has the tree itself as an argument (argv word %s)' "$pid" "$word"; return 0;;
        "$branch")
          printf 'pid %s has the branch %s as an argument' "$pid" "$branch"; return 0;;
      esac
    done < <(tr '\0' '\n' < "$p/cmdline" 2>/dev/null)
  done
  return 1
}

# Rule 1b: the night itself said this story is PARKED or BLOCKED. state.txt
# carries only "<id> <rc> <ISO>", so the verdict is read from the story's RESULT
# line and from the night report.
# It is written WITHOUT grep, on purpose, and this is not a style choice.
# The previous version asked grep three times and checked its exit code none of
# those times, so a grep that FAILED (rc 2) was read as "did not match", i.e.
# "not parked" — the file's recurring bug class, empty output as an all-clear.
# Proven: with a grep that exits 2, a story whose log said
# "RESULT S3 parked waiting on owner ruling" went from KEEP to REMOVE and the
# tool exited 0, which is the signal PHASE F branches on. The counter-argument
# that reaching REMOVE still needs clean+pushed+merged is true and not enough: a
# parked story's tree then silently vanishes under an all-clear.
# It also interpolated $id UNESCAPED into two EREs, so a queue id holding a
# regex metacharacter made those greps exit 2 with no shim needed at all. Every
# comparison below is a literal bash `case`, and a file that exists but cannot
# be read answers PARKED (the check that cannot be performed fails to KEEP).
parked_or_blocked(){ # <id>
  local id=$1 line rep l up idu sid src _rest
  idu=${id^^}
  if [ -f "$LOGS/$id.log" ]; then
    if [ ! -r "$LOGS/$id.log" ]; then
      printf 'the story log %s.log exists but cannot be read, so PARKED/BLOCKED cannot be ruled out' "$id"
      return 0
    fi
    line=""
    while IFS= read -r l || [ -n "$l" ]; do
      case "$l" in "RESULT $id "*) line=$l;; esac
    done < "$LOGS/$id.log"
    case "$line" in
      *" parked "*|*" blocked "*|*review=parked*) printf 'the run reported it %s' "${line#RESULT }"; return 0;;
    esac
  fi
  for rep in "$NIGHT_DIR"/REPORT-*.md; do
    [ -f "$rep" ] || continue
    if [ ! -r "$rep" ]; then
      printf 'the night report %s cannot be read, so PARKED/BLOCKED cannot be ruled out' "$(basename "$rep")"
      return 0
    fi
    while IFS= read -r l || [ -n "$l" ]; do
      up=${l^^}
      case "$up" in *PARKED*|*BLOCKED*) :;; *) continue;; esac
      # The id must appear on that same line as a whole word. Literal `case`
      # patterns: a metacharacter in the id is just a character here. The old
      # ERE also demanded the id come BEFORE the word; dropping that ordering
      # can only produce MORE KEEPs, which is the safe direction.
      case "$up" in
        "$idu"|"$idu"[!A-Z0-9]*|*[!A-Z0-9]"$idu"|*[!A-Z0-9]"$idu"[!A-Z0-9]*)
          printf 'the night report lists it as PARKED/BLOCKED (%s)' "${rep##*/}"
          return 0;;
      esac
    done < "$rep"
  done
  if [ -f "$STATE" ]; then
    if [ ! -r "$STATE" ]; then
      printf 'state.txt exists but cannot be read, so a non-zero story exit cannot be ruled out'
      return 0
    fi
    while read -r sid src _rest || [ -n "${sid:-}" ]; do
      [ "$sid" = "$id" ] || continue
      case "$src" in ''|*[!0-9]*) continue;; esac
      if [ "$src" -ne 0 ]; then
        printf 'state.txt records a non-zero exit (%s) for the story' "$src"
        return 0
      fi
    done < "$STATE"
  fi
  return 1
}

# Was the branch's PR merged? Anything other than a clear MERGED means KEEP,
# including gh being absent or failing.
pr_merged(){ # <branch> ; echoes the PR number on success
  local branch=$1 out rc first
  command -v "$GH_BIN" >/dev/null 2>&1 || return 1
  # </dev/null: gh is a child of the per-tree loop and inherits its stdin. A gh
  # that reads stdin (a wrapper, a pager, an auth prompt) DRAINS the record file
  # the loop is reading, and the remaining trees are then never evaluated and
  # never mentioned — proven with a two-line stub. The loop itself now reads the
  # record on fd 3, so this is the second lock on the same door.
  out=$("$GH_BIN" pr list -R "$REPO" --head "$branch" --state merged \
        --json number,state --jq '.[]|select(.state=="MERGED")|.number' 2>/dev/null </dev/null)
  rc=$?
  # gh failed (no auth, no network, API error, rate limit) -> merge status is
  # UNKNOWN, and unknown is KEEP.
  [ $rc -eq 0 ] || return 1
  first=$(printf '%s\n' "$out" | sed -n '1p')
  first=${first%$'\r'}
  # The first line must be a PR number and NOTHING else. The old code squeezed
  # digits out of whatever gh printed with `tr -dc '0-9'`, which turns an error
  # body like "HTTP 502" into "PR #502 merged" and removes a tree on the
  # strength of a failed API call. An error body is not a number; reject it.
  case "$first" in
    ''|*[!0-9]*) return 1;;
  esac
  printf '%s' "$first"
}

# The main worktree of the repo a tree belongs to, so `git worktree remove` and
# `git worktree prune` are never run from inside the tree being removed and
# never against some other repository on this machine.
main_worktree_of(){ # <path>
  local common
  common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  dirname "$common"
}

# -------------------------------------------------------------- the decision --
ATTENTION=0
REMOVED=0
FETCH_OK=""
FETCH_FAILED=""
MERGED_BRANCHES=""
SEEN_PATHS=""
PRUNE_DIRS=""
ROWS=""

printf '%s\n' "== night worktree cleanup — project $PROJECT, $( [ $ACT -eq 1 ] && echo 'APPLY (trees will be removed)' || echo 'DRY RUN (nothing will be removed)' )"
printf '%s\n' "   record: $TSV"
if [ $FETCH -eq 0 ]; then
  printf '%s\n' "   --no-fetch: origin/* was NOT refreshed. Every rule below is still evaluated, against the refs already on disk, but a removal verdict is reported as WOULD-REMOVE (unverified) and NOTHING is removed."
fi

record(){ # <id> <decision> <reason>
  ROWS="$ROWS$1	$2	$3
"
}

# The record is read on FD 3, never on stdin. With `done < "$TSV"` every command
# in this loop body inherits the open record as its stdin, and any child that
# reads stdin swallows the rest of it: a `gh` wrapper that did so left three of
# four trees unevaluated and unmentioned — a dirty or parked tree silently
# dropping out of the report, with no line saying it was skipped.
while IFS=$'\t' read -r id path branch created <&3 || [ -n "${id:-}" ]; do
  id=${id%$'\r'}; branch=${branch%$'\r'}; path=${path%$'\r'}
  [ -z "${id:-}" ] && continue
  case "$id" in \#*) continue;; esac
  : "${created:=}"
  if [ -z "${path:-}" ] || [ -z "${branch:-}" ]; then
    record "$id" "KEEP" "malformed worktrees.tsv row (path or branch empty) — nothing touched"
    ATTENTION=1
    continue
  fi

  real=$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")
  case "$SEEN_PATHS" in
    *"|$real|"*) continue;;   # the tsv gets one row per story START; a resumed story appends a second
  esac
  SEEN_PATHS="$SEEN_PATHS|$real|"

  # A recorded path that is gone is not an error: the tree was already removed
  # by hand or by an earlier cleanup. Nothing to do, and NOTHING to prune from
  # here: the parent of a missing tree is $NIGHT_DIR/wt, which is a plain
  # directory and never a repository. Feeding it to the prune list (as this
  # loop used to) put a non-repo path on the same list as real repositories.
  # Only a tree this run actually removed ever adds its repo to that list.
  if [ ! -d "$real" ]; then
    record "$id" "GONE" "recorded path no longer exists ($path) — nothing to remove"
    continue
  fi

  # Backstop against a mis-recorded row: this tool only ever removes trees that
  # live under the run's own $NIGHT_DIR.
  case "$real" in
    "$NIGHT_DIR_REAL"/*) :;;
    *) record "$id" "KEEP" "rule 0: $path is outside NIGHT_DIR — this tool never removes trees it does not own"; continue;;
  esac

  if reason=$(tree_in_use "$real" "$branch"); then
    record "$id" "KEEP" "rule 1: in use — $reason"
    continue
  fi

  if reason=$(parked_or_blocked "$id"); then
    record "$id" "KEEP" "rule 1b: PARKED/BLOCKED — $reason"
    ATTENTION=1
    continue
  fi

  if ! git -C "$real" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    record "$id" "KEEP" "rule 1c: $path is not a usable git worktree — left alone for the owner"
    ATTENTION=1
    continue
  fi

  # Rule 2a — the remote-tracking refs that rules 2, 3b and 4 judge against must
  # be FRESH. A stale origin/<branch> makes "already pushed" and "already
  # merged" meaningless, and this is the one failure that is invisible in the
  # output: every check below then passes cheerfully against yesterday's refs.
  #
  # So the fetch is decided PER REPOSITORY and its result is remembered per
  # repository. Previously a single early main_worktree_of failure stored the
  # empty key "||" in the fetched-list, and because every later lookup then
  # matched that same "||", the fetch was silently skipped for EVERY remaining
  # tree. Now: repo unknown -> KEEP; fetch failed -> that repo's trees are KEPT
  # and the failure is printed.
  main=$(main_worktree_of "$real" || printf '')
  if [ -z "$main" ]; then
    record "$id" "KEEP" "rule 2a: could not locate the repository of $path (git rev-parse --git-common-dir failed) — nothing about this tree can be proven"
    ATTENTION=1
    continue
  fi
  if [ $FETCH -eq 1 ]; then
    case "$FETCH_OK|$FETCH_FAILED" in
      *"|$main|"*) :;;
      *)
        if fetch_err=$(git -C "$real" fetch --quiet origin 2>&1); then
          FETCH_OK="$FETCH_OK|$main|"
        else
          FETCH_FAILED="$FETCH_FAILED|$main|"
          printf '   git fetch origin FAILED in %s — %s\n' "$main" "${fetch_err%%$'\n'*}"
        fi;;
    esac
    case "$FETCH_FAILED" in
      *"|$main|"*)
        record "$id" "KEEP" "rule 2a: git fetch origin failed in $main — origin/* may be stale, so 'pushed' and 'merged' cannot be proven"
        ATTENTION=1
        continue;;
    esac
  fi
  # No `else` branch: under --no-fetch the rules below run NORMALLY against the
  # refs already on disk, and only the ACTION is withheld (ACT is forced to 0
  # above, and a removal verdict is recorded as WOULD-REMOVE, unverified). The
  # old code KEPT every tree here, which was fail-closed but useless: it printed
  # N identical rule-2a lines, showed nothing `cat worktrees.tsv` would not, and
  # was indistinguishable from a completely broken run. Note what did NOT
  # change: there is no trust-the-caller path. `git fetch --quiet origin` on a
  # current repo costs ~200ms and is idempotent, which is cheaper than reasoning
  # about whether some earlier fetch covered this repo, this remote and this
  # moment; --assume-fetched is deliberately not offered.

  # The tree must still be on the branch we recorded; if someone checked out
  # something else in it, every check below would be answering about the wrong
  # branch.
  head_branch=$(git -C "$real" symbolic-ref --quiet --short HEAD 2>/dev/null || printf '')
  if [ "$head_branch" != "$branch" ]; then
    record "$id" "KEEP" "rule 1d: tree is on '${head_branch:-a detached HEAD}', not the recorded branch '$branch'"
    ATTENTION=1
    continue
  fi

  # ---------------------------------------------------------------------------
  # RULE 2 — THE SINGLE MOST IMPORTANT RULE IN THIS FILE.
  # Does the branch exist on the remote AT ALL? A non-zero exit means it was
  # never pushed, so the tree holds the only copy of its commits: KEEP and stop.
  # This MUST be evaluated before any other git check, because
  #   git cherry -v origin/<branch-that-does-not-exist> HEAD
  # prints NOTHING and exits 128. A rule that reads "empty cherry output means
  # nothing unpushed" would therefore delete every commit of a never-pushed
  # branch — the exact shape of the incident that destroyed uncommitted work.
  # ---------------------------------------------------------------------------
  if ! git -C "$real" rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null 2>&1; then
    record "$id" "KEEP" "rule 2: origin/$branch does not exist — the branch was never pushed, this tree is the only copy"
    ATTENTION=1
    continue
  fi

  # RULE 4 IS EVALUATED FIRST OF THE LAST THREE, DELIBERATELY. It is a NETWORK
  # round trip (`gh pr list`, 0.3-3s per tree) and it used to sit BETWEEN the
  # dirty check and `git worktree remove`. Everything written into the tree
  # during that window was deleted: proven with a `gh` that dropped a gitignored
  # .env into the tree and slept 2s — the run reported
  # "REMOVE removed: clean, pushed, PR #4242 merged" and the only copy of that
  # file was destroyed. Rule 5 unforced does not refuse gitignored content, and
  # rule 1 cannot see a writer whose cwd is elsewhere and whose argv never names
  # the path (a dev server, a sync agent, a `make` started from the parent).
  # The slow call is now the FIRST of the three and the dirty check is re-run
  # immediately before the removal, which leaves microseconds, not seconds.
  #
  # Its verdict is only RECORDED after rules 3a/3b, so the documented precedence
  # is unchanged: a dirty or unpushed tree is still reported as rule 3 and still
  # sets ATTENTION, rather than being reported as "no merged PR" with exit 0.
  if pr=$(pr_merged "$branch"); then
    pr_ok=1
  else
    pr_ok=0
    pr=""
  fi

  # Rule 3a — dirty? --ignored=matching is deliberate: plain --porcelain hides
  # gitignored files, and a local-only .env or credentials file is exactly the
  # unrecoverable case.
  #
  # THE EXIT CODE IS THE SAFETY CHECK, NOT THE OUTPUT. With
  # status.showUntrackedFiles=no set in any repo, global or system gitconfig,
  # this exact command is a hard error: "fatal: Unsupported combination of
  # ignored and untracked-files arguments", exit 128, ZERO bytes on stdout.
  # Reading that empty stdout as "clean" passes rules 3 and 4, and `git worktree
  # remove` then succeeds too, because the same setting silences ITS internal
  # check — proven to destroy a tree holding only untracked files. A non-zero
  # exit means the safety check could not be completed, which means KEEP.
  # stderr is captured deliberately: on a successful run git says nothing here,
  # so anything it does say is news and being kept for it is the cheap outcome.
  dirty=$(git -C "$real" status --porcelain --ignored=matching 2>&1)
  status_rc=$?
  if [ $status_rc -ne 0 ]; then
    record "$id" "KEEP" "rule 3: the dirty-tree safety check could not be completed — git status --porcelain --ignored=matching exited $status_rc (${dirty%%$'\n'*}); nothing is removed on an unanswered safety check"
    ATTENTION=1
    continue
  fi
  if [ -n "$dirty" ]; then
    n=0
    while IFS= read -r dline || [ -n "$dline" ]; do
      [ -n "$dline" ] && n=$((n + 1))
    done <<<"$dirty"
    record "$id" "KEEP" "rule 3: working tree not clean — $n path(s) per git status --porcelain --ignored=matching (includes ignored files such as .env)"
    ATTENTION=1
    continue
  fi

  # Rule 3b — unpushed commits? Only reachable once rule 2 proved origin/<branch>
  # exists AND the exit code is checked below, so an empty result here really
  # does mean "nothing unpushed" (empty output alone never would: `git cherry -v
  # origin/<missing-branch> HEAD` prints nothing and exits 128).
  cherry=$(git -C "$real" cherry -v "origin/$branch" HEAD 2>&1)
  cherry_rc=$?
  if [ $cherry_rc -ne 0 ]; then
    record "$id" "KEEP" "rule 3: git cherry against origin/$branch failed (exit $cherry_rc: ${cherry%%$'\n'*}) — cannot prove the work is pushed"
    ATTENTION=1
    continue
  fi
  # Counted in bash, not by `grep -c '^+ '`. That was the last survivor of this
  # file's recurring bug class: its exit code was unchecked, and a grep that
  # fails prints nothing, so $ahead became the EMPTY STRING, the test below died
  # with "integer expression expected" and execution fell through to REMOVE.
  # Proven: a tree with one unpushed commit went from
  # "KEEP rule 3: 1 commit(s) not on origin/…" to "REMOVE … TREE DELETED" under
  # a grep shim. A bash loop has no exit code to ignore and nothing to shim.
  ahead=0
  while IFS= read -r cline || [ -n "$cline" ]; do
    case "$cline" in '+ '*) ahead=$((ahead + 1));; esac
  done <<<"$cherry"
  if [ "$ahead" -gt 0 ]; then
    record "$id" "KEEP" "rule 3: $ahead commit(s) not on origin/$branch (git cherry '+')"
    ATTENTION=1
    continue
  fi

  # Rule 4's verdict, now that rules 3a and 3b have had first claim on the row.
  if [ $pr_ok -ne 1 ]; then
    record "$id" "KEEP" "rule 4: no MERGED PR found for $branch in $REPO (or gh could not answer) — the work is still open"
    continue
  fi

  # Rule 5 — remove, WITHOUT --force. --force is forbidden here, always. But do
  # not mistake the unforced form for a safety net: it refuses a tree with
  # MODIFIED TRACKED files and nothing else. A tree whose entire content is
  # untracked or gitignored (a local .env) is deleted by it with exit 0, and
  # status.showUntrackedFiles=no silences its internal check completely. Rule 3
  # above — our own status call, exit code checked — is the only real guard.
  if [ $ACT -eq 0 ]; then
    if [ $FETCH -eq 0 ]; then
      # The real verdict, labelled for what it is worth: every rule passed, but
      # against origin/* refs that were never refreshed. Not added to the
      # merged-branch suggestions — a branch-delete suggestion off stale refs is
      # exactly the advice this tool must not give.
      record "$id" "WOULD-REMOVE" "unverified — --no-fetch, origin/* not refreshed: clean, pushed and PR #$pr merged according to the refs already on disk; would run: git worktree remove $path"
    else
      record "$id" "REMOVE" "clean, pushed, PR #$pr merged — would run: git worktree remove $path (dry run, nothing done)"
      MERGED_BRANCHES="$MERGED_BRANCHES  $branch (PR #$pr)
"
    fi
    continue
  fi
  # $main was located and validated by rule 2a above; re-check it is still a
  # directory, because `git worktree remove` must never be run blind.
  if [ -z "$main" ] || [ ! -d "$main" ]; then
    record "$id" "KEEP" "rule 5: could not locate the main worktree of $path — refusing to run git worktree remove blind"
    ATTENTION=1
    continue
  fi
  # ---------------------------------------------------------------------------
  # RULE 3, RE-RUN. The dirty check above and this destructive call are two
  # separate commands, and a gh round trip used to sit between them: everything
  # a third party wrote into the tree in that window was deleted. Same command,
  # same rc check, same 2>&1 fold, executed with nothing but this `if` between
  # it and `git worktree remove`.
  #
  # The 2>&1 is LOAD-BEARING and must never be "tidied" away: an unreadable
  # subdirectory makes `git status` exit 0 with EMPTY stdout and emit only a
  # warning on stderr, and folding stderr into stdout is what turns that into a
  # KEEP. Any output at all, or any non-zero rc, means KEEP.
  # ---------------------------------------------------------------------------
  recheck=$(git -C "$real" status --porcelain --ignored=matching 2>&1)
  recheck_rc=$?
  if [ $recheck_rc -ne 0 ]; then
    record "$id" "KEEP" "rule 3 (re-check): the dirty-tree safety check could not be completed immediately before the removal — git status --porcelain --ignored=matching exited $recheck_rc (${recheck%%$'\n'*}); nothing is removed on an unanswered safety check"
    ATTENTION=1
    continue
  fi
  if [ -n "$recheck" ]; then
    record "$id" "KEEP" "rule 3 (re-check): the tree stopped being clean while this run was deciding about it (${recheck%%$'\n'*}) — something is writing into it; nothing removed"
    ATTENTION=1
    continue
  fi
  if out=$(git -C "$main" worktree remove "$path" 2>&1 </dev/null); then
    REMOVED=$((REMOVED + 1))
    PRUNE_DIRS="$PRUNE_DIRS
$main"
    MERGED_BRANCHES="$MERGED_BRANCHES  $branch (PR #$pr)
"
    record "$id" "REMOVE" "removed: clean, pushed, PR #$pr merged (git worktree remove, no --force)"
  else
    record "$id" "KEEP" "rule 5: git worktree remove refused it — ${out%%$'\n'*}"
    ATTENTION=1
  fi
done 3< "$TSV"

# ------------------------------------------------------------------- prune ----
# OFF BY DEFAULT, behind --prune, because `git worktree prune` is REPO-WIDE and
# there is no per-project form of it. Scoping the *repository* is not enough:
# once it runs, it walks EVERY worktree registered in that repository and
# de-registers each one whose directory it cannot see — other projects' trees
# and other sessions' live trees included. During review it de-registered an
# unrelated LIVE worktree, and the innotel-bss night runner shares its repo with
# exactly such trees. A successful `git worktree remove` already deletes its own
# administrative directory, so pruning after it buys nothing; the flag exists
# only for a repo with known-stale metadata, run deliberately by the owner.
# PRUNE_DIRS holds the main worktree of repos we actually removed from — never a
# path derived from a GONE row, which would be $NIGHT_DIR/wt, not a repository.
prune_step(){
  if [ $PRUNE -eq 1 ] && [ $ACT -eq 1 ] && [ $REMOVED -gt 0 ]; then
    printf '%s\n' "$PRUNE_DIRS" | grep -v '^$' | sort -u | while IFS= read -r d; do
      [ -d "$d" ] || continue
      git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 </dev/null || continue
      printf '%s\n' "--prune: running REPO-WIDE git worktree prune in $d — this touches every worktree registered there, not only this project's"
      git -C "$d" worktree prune 2>/dev/null </dev/null && printf 'pruned worktree metadata in %s\n' "$d"
    done
  elif [ $ACT -eq 1 ] && [ $REMOVED -gt 0 ]; then
    printf 'git worktree prune was NOT run (it is repo-wide and off by default); git worktree remove cleaned up after itself.\n'
  fi
}

# ----------------------------------------------------------------- summary ----
printf '\n%-10s %-13s %s\n' "ID" "ACTION" "REASON"
printf '%-10s %-13s %s\n' "----------" "-------------" "------------------------------------------------------------"
if [ -n "$ROWS" ]; then
  printf '%s' "$ROWS" | while IFS=$'\t' read -r rid rdec rreason; do
    [ -z "${rid:-}" ] && continue
    printf '%-10s %-13s %s\n' "$rid" "$rdec" "$rreason"
  done
else
  printf '(worktrees.tsv holds no usable rows)\n'
fi

if [ -n "$MERGED_BRANCHES" ]; then
  printf '\nMerged branches — SUGGESTION ONLY, this tool never deletes a branch.\n'
  printf 'Delete them yourself with the PR in front of you if you want them gone:\n'
  printf '%s' "$MERGED_BRANCHES"
fi

if [ $ACT -eq 0 ]; then
  if [ $FETCH -eq 0 ]; then
    printf '\n--no-fetch — nothing was removed, and nothing could be: every WOULD-REMOVE row is a verdict against origin/* refs that were never refreshed. Re-run WITHOUT --no-fetch (a fetch on a current repo costs ~200ms and is idempotent) to turn them into real REMOVE rows.\n'
  else
    printf '\nDRY RUN — nothing was removed. Re-run with --apply to act on the REMOVE rows.\n'
  fi
else
  printf '\n%s tree(s) removed.\n' "$REMOVED"
fi
prune_step

if [ $ATTENTION -ne 0 ]; then
  printf 'Some trees were KEPT for a reason you should look at (dirty, unpushed, parked or blocked) — see the KEEP rows above.\n'
  exit 1
fi
exit 0
