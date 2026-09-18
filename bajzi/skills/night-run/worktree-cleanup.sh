#!/usr/bin/env bash
# worktree-cleanup.sh — morning (PHASE F) cleanup of a night run's worktrees.
# Shared by every project, never edited per project: all facts come from the
# same config.env the runner uses (templates/config.env.tmpl).
#
# Usage:
#   worktree-cleanup.sh --config <path/to/config.env> [--apply] [--no-fetch] [--prune]
#   (--config may be replaced by the NIGHT_CONFIG environment variable.)
#
#   (no flag)   DRY RUN — decides and prints, removes NOTHING. The default.
#   --apply     actually run `git worktree remove` for the trees decided REMOVE.
#   --no-fetch  skip the `git fetch` that refreshes origin/* before judging.
#               Without a fetch nothing can be proven pushed or merged, so every
#               tree is KEPT: the flag is for offline inspection, not cleanup.
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
#   5. everything above passed -> `git worktree remove <path>`, never --force.
#
# EVERY git/gh call above is judged on its EXIT CODE first and its output
# second. A failed command prints nothing, and "no output" read as "nothing
# wrong" is how this tool destroys work: `git status --porcelain
# --ignored=matching` exits 128 with zero bytes on stdout when
# status.showUntrackedFiles=no is set anywhere in the config chain, and
# `git cherry -v origin/<missing-branch>` does the same. So: non-zero exit from
# any safety check means the check COULD NOT BE COMPLETED, which means KEEP.
#
# `git worktree remove` without --force is NOT a backstop. It refuses a tree
# with modified tracked files, but it happily deletes a tree whose only content
# is untracked or gitignored (a local .env), and the same
# status.showUntrackedFiles=no silences its internal check as well. Rule 3 —
# our own status call, with its exit code checked — is the only real guard.
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
PRUNE=0
usage(){ sed -n '2,21p' "$0" >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --config)   [ $# -ge 2 ] || { echo "worktree-cleanup.sh: --config needs a path" >&2; exit 2; }; CONFIG=$2; shift;;
    --apply)    APPLY=1;;
    --no-fetch) FETCH=0;;
    --prune)    PRUNE=1;;
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
  local branch=$1 out rc first
  command -v "$GH_BIN" >/dev/null 2>&1 || return 1
  out=$("$GH_BIN" pr list -R "$REPO" --head "$branch" --state merged \
        --json number,state --jq '.[]|select(.state=="MERGED")|.number' 2>/dev/null)
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
  else
    record "$id" "KEEP" "rule 2a: --no-fetch was passed, so origin/* was never refreshed — 'pushed' and 'merged' cannot be proven against possibly stale refs"
    ATTENTION=1
    continue
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
    n=$(printf '%s\n' "$dirty" | grep -c .)
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

  # Rule 5 — remove, WITHOUT --force. --force is forbidden here, always. But do
  # not mistake the unforced form for a safety net: it refuses a tree with
  # MODIFIED TRACKED files and nothing else. A tree whose entire content is
  # untracked or gitignored (a local .env) is deleted by it with exit 0, and
  # status.showUntrackedFiles=no silences its internal check completely. Rule 3
  # above — our own status call, exit code checked — is the only real guard.
  if [ $APPLY -eq 0 ]; then
    record "$id" "REMOVE" "clean, pushed, PR #$pr merged — would run: git worktree remove $path (dry run, nothing done)"
    MERGED_BRANCHES="$MERGED_BRANCHES  $branch (PR #$pr)
"
    continue
  fi
  # $main was located and validated by rule 2a above; re-check it is still a
  # directory, because `git worktree remove` must never be run blind.
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
if [ $PRUNE -eq 1 ] && [ $APPLY -eq 1 ] && [ $REMOVED -gt 0 ]; then
  printf '%s\n' "$PRUNE_DIRS" | grep -v '^$' | sort -u | while IFS= read -r d; do
    [ -d "$d" ] || continue
    git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
    printf '%s\n' "--prune: running REPO-WIDE git worktree prune in $d — this touches every worktree registered there, not only this project's"
    git -C "$d" worktree prune 2>/dev/null && printf 'pruned worktree metadata in %s\n' "$d"
  done
elif [ $APPLY -eq 1 ] && [ $REMOVED -gt 0 ]; then
  printf 'git worktree prune was NOT run (it is repo-wide and off by default); git worktree remove cleaned up after itself.\n'
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
