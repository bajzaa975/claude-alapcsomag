#!/usr/bin/env bash
# worktree-cleanup.sh — morning (PHASE F) cleanup of a night run's worktrees.
# Shared by every project, never edited per project: all facts come from the
# same config.env the runner uses (templates/config.env.tmpl).
#
# Usage:
#   worktree-cleanup.sh --config <path/to/config.env> [--apply] [--no-fetch]
#   (--config may be replaced by the NIGHT_CONFIG environment variable.)
#
#   (no flag)   DRY RUN — decides and prints, removes NOTHING. The default.
#   --apply     actually run `git worktree remove` for the trees decided REMOVE.
#   --no-fetch  skip the `git fetch` that refreshes origin/* before judging.
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
#   2. `git rev-parse --verify origin/<branch>` exits non-zero          -> KEEP
#   3. dirty (`git status --porcelain --ignored=matching`) or unpushed
#      (`git cherry -v origin/<branch> HEAD` lists `+` commits)         -> KEEP
#   4. no MERGED PR for the branch                                      -> KEEP
#   5. everything above passed -> `git worktree remove <path>`, never --force.
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
CONFIG=${NIGHT_CONFIG:-}
APPLY=0
FETCH=1
usage(){ sed -n '2,12p' "$0" >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --config)   [ $# -ge 2 ] || { echo "worktree-cleanup.sh: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    --apply)    APPLY=1;;
    --no-fetch) FETCH=0;;
    -h|--help)  usage; exit 0;;
    *) echo "worktree-cleanup.sh: unknown argument $1" >&2; usage; exit 2;;
  esac
  shift
done

if [ -z "$CONFIG" ]; then
  echo "worktree-cleanup.sh: no config — pass --config <path/to/config.env> or set NIGHT_CONFIG." >&2
  exit 2
fi
[ -f "$CONFIG" ] || { echo "worktree-cleanup.sh: config file not found: $CONFIG" >&2; exit 2; }
# shellcheck source=/dev/null
. "$CONFIG"

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

# Rule 1: any process whose cwd sits inside the tree, or a story session whose
# command line still names the tree or its branch.
tree_in_use(){ # <real path> <branch>
  local path=$1 branch=$2 p pid link
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "${PPID:-0}" ] && continue
    link=$(readlink "$p/cwd" 2>/dev/null) || continue
    case "$link" in "$path"|"$path"/*) printf 'pid %s has its cwd in the tree' "$pid"; return 0;; esac
  done
  for pid in $(pgrep -f "$path" 2>/dev/null) $(pgrep -f "$branch" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "${PPID:-0}" ] && continue
    printf 'a session for this story is still running (pid %s)' "$pid"
    return 0
  done
  return 1
}

# Rule 1b: the night itself said this story is PARKED or BLOCKED. state.txt
# carries only "<id> <rc> <ISO>", so the verdict is read from the story's RESULT
# line and from the night report.
parked_or_blocked(){ # <id>
  local id=$1 line rep
  if [ -f "$LOGS/$id.log" ]; then
    line=$(grep -h "^RESULT $id " "$LOGS/$id.log" 2>/dev/null | tail -1)
    case "$line" in
      *" parked "*|*" blocked "*|*review=parked*) printf 'the run reported it %s' "${line#RESULT }"; return 0;;
    esac
  fi
  for rep in "$NIGHT_DIR"/REPORT-*.md; do
    [ -f "$rep" ] || continue
    if grep -Eiq "(^|[^A-Za-z0-9])$id([^A-Za-z0-9].*)?(PARKED|BLOCKED)" "$rep"; then
      printf 'the night report lists it as PARKED/BLOCKED (%s)' "$(basename "$rep")"
      return 0
    fi
  done
  if [ -f "$STATE" ] && grep -Eq "^$id +[1-9][0-9]* " "$STATE"; then
    printf 'state.txt records a non-zero exit for the story'
    return 0
  fi
  return 1
}

# Was the branch's PR merged? Anything other than a clear MERGED means KEEP,
# including gh being absent or failing.
pr_merged(){ # <branch> ; echoes the PR number on success
  local branch=$1 out
  command -v "$GH_BIN" >/dev/null 2>&1 || return 1
  out=$("$GH_BIN" pr list -R "$REPO" --head "$branch" --state merged \
        --json number,state --jq '.[]|select(.state=="MERGED")|.number' 2>/dev/null) || return 1
  out=$(printf '%s\n' "$out" | head -1 | tr -dc '0-9')
  [ -n "$out" ] || return 1
  printf '%s' "$out"
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
FETCHED=""
MERGED_BRANCHES=""
SEEN_PATHS=""
PRUNE_DIRS=""
ROWS=""

printf '%s\n' "== night worktree cleanup — project $PROJECT, $( [ $APPLY -eq 1 ] && echo 'APPLY (trees will be removed)' || echo 'DRY RUN (nothing will be removed)' )"
printf '%s\n' "   record: $TSV"

record(){ # <id> <decision> <reason>
  ROWS="$ROWS$1	$2	$3
"
}

while IFS=$'\t' read -r id path branch created || [ -n "${id:-}" ]; do
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
  # by hand or by an earlier cleanup. Nothing to do but let prune drop the stale
  # administrative file later.
  if [ ! -d "$real" ]; then
    record "$id" "GONE" "recorded path no longer exists ($path) — nothing to remove"
    PRUNE_DIRS="$PRUNE_DIRS
$(dirname "$real")"
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

  if [ $FETCH -eq 1 ]; then
    main=$(main_worktree_of "$real" || true)
    case "$FETCHED" in
      *"|$main|"*) :;;
      *) git -C "$real" fetch --quiet origin 2>/dev/null; FETCHED="$FETCHED|$main|";;
    esac
  fi

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

  # Rule 3a — dirty? --ignored=matching is deliberate: plain --porcelain hides
  # gitignored files, and a local-only .env or credentials file is exactly the
  # unrecoverable case.
  dirty=$(git -C "$real" status --porcelain --ignored=matching 2>/dev/null)
  if [ -n "$dirty" ]; then
    n=$(printf '%s\n' "$dirty" | grep -c .)
    record "$id" "KEEP" "rule 3: working tree not clean — $n path(s) per git status --porcelain --ignored=matching (includes ignored files such as .env)"
    ATTENTION=1
    continue
  fi

  # Rule 3b — unpushed commits? Only reachable once rule 2 proved origin/<branch>
  # exists, so an empty result here really does mean "nothing unpushed".
  cherry=$(git -C "$real" cherry -v "origin/$branch" HEAD 2>/dev/null)
  cherry_rc=$?
  if [ $cherry_rc -ne 0 ]; then
    record "$id" "KEEP" "rule 3: git cherry against origin/$branch failed (exit $cherry_rc) — cannot prove the work is pushed"
    ATTENTION=1
    continue
  fi
  ahead=$(printf '%s\n' "$cherry" | grep -c '^+ ')
  if [ "$ahead" -gt 0 ]; then
    record "$id" "KEEP" "rule 3: $ahead commit(s) not on origin/$branch (git cherry '+')"
    ATTENTION=1
    continue
  fi

  # Rule 4 — merged PR?
  if ! pr=$(pr_merged "$branch"); then
    record "$id" "KEEP" "rule 4: no MERGED PR found for $branch in $REPO (or gh could not answer) — the work is still open"
    continue
  fi

  # Rule 5 — remove, WITHOUT --force. The unforced form refuses to delete a tree
  # that still has changes in it and is the last backstop after rules 1-4;
  # passing --force removes that backstop and is forbidden here, always.
  if [ $APPLY -eq 0 ]; then
    record "$id" "REMOVE" "clean, pushed, PR #$pr merged — would run: git worktree remove $path (dry run, nothing done)"
    MERGED_BRANCHES="$MERGED_BRANCHES  $branch (PR #$pr)
"
    continue
  fi
  main=$(main_worktree_of "$real" || printf '')
  if [ -z "$main" ] || [ ! -d "$main" ]; then
    record "$id" "KEEP" "rule 5: could not locate the main worktree of $path — refusing to run git worktree remove blind"
    ATTENTION=1
    continue
  fi
  if out=$(git -C "$main" worktree remove "$path" 2>&1); then
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
done < "$TSV"

# ------------------------------------------------------------------- prune ----
# Only AFTER the removals, and only in the repositories this run's own trees
# belong to. Never a blanket prune of every repo on the machine.
if [ $APPLY -eq 1 ] && [ $REMOVED -gt 0 ]; then
  for d in $(printf '%s\n' "$PRUNE_DIRS" | grep -v '^$' | sort -u); do
    [ -d "$d" ] || continue
    git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
    git -C "$d" worktree prune 2>/dev/null && printf 'pruned worktree metadata in %s\n' "$d"
  done
fi

# ----------------------------------------------------------------- summary ----
printf '\n%-10s %-7s %s\n' "ID" "ACTION" "REASON"
printf '%-10s %-7s %s\n' "----------" "-------" "------------------------------------------------------------"
if [ -n "$ROWS" ]; then
  printf '%s' "$ROWS" | while IFS=$'\t' read -r rid rdec rreason; do
    [ -z "${rid:-}" ] && continue
    printf '%-10s %-7s %s\n' "$rid" "$rdec" "$rreason"
  done
else
  printf '(worktrees.tsv holds no usable rows)\n'
fi

if [ -n "$MERGED_BRANCHES" ]; then
  printf '\nMerged branches — SUGGESTION ONLY, this tool never deletes a branch.\n'
  printf 'Delete them yourself with the PR in front of you if you want them gone:\n'
  printf '%s' "$MERGED_BRANCHES"
fi

if [ $APPLY -eq 0 ]; then
  printf '\nDRY RUN — nothing was removed. Re-run with --apply to act on the REMOVE rows.\n'
else
  printf '\n%s tree(s) removed.\n' "$REMOVED"
fi

if [ $ATTENTION -ne 0 ]; then
  printf 'Some trees were KEPT for a reason you should look at (dirty, unpushed, parked or blocked) — see the KEEP rows above.\n'
  exit 1
fi
exit 0
