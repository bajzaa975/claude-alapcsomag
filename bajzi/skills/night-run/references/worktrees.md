# Night-run worktrees — record, creation, cleanup

Every story of a night run gets its own git worktree, and the run owns each tree
from birth to cleanup. Two real incidents from the innotel-bss nights set the
rules below, and both are cheap to repeat:

- **18 stale trees** piled up because night worktrees lived loose in `$HOME`,
  with nothing that said which run had created which directory.
- **A cleanup destroyed four uncommitted files** in one of those trees, because
  it matched a name pattern instead of reading a record, and deleted a tree
  whose work existed nowhere else.

Everything here follows from those two: a tree is only ever touched because a
record says this run created it, and every check fails towards KEEP.

## 1. Naming

    <path>    $NIGHT_DIR/wt/<id>                     e.g. ~/night-runs/innotel-bss/wt/S49
    <branch>  feat/<BRANCH_PREFIX>-<id>-<slug>       e.g. feat/bss-S49-invoice-pdf

`NIGHT_DIR` and `BRANCH_PREFIX` come from `config.env`; `<id>` and `<slug>` are
columns 1 and 2 of the queue line. Trees live under the run's own night
directory, never in `$HOME`: cleanup is then scoped by construction — everything
under `wt/` belongs to this project's night runs and nothing else does.

## 2. The `worktrees.tsv` contract

    $NIGHT_DIR/worktrees.tsv

Tab-separated, no header, one row per tree the run creates:

| # | column  | value                                                      |
|---|---------|------------------------------------------------------------|
| 1 | id      | the queue id, e.g. `S49`                                    |
| 2 | path    | absolute path of the worktree, `$NIGHT_DIR/wt/<id>`         |
| 3 | branch  | full branch name, `feat/<BRANCH_PREFIX>-<id>-<slug>`        |
| 4 | created | ISO-8601 UTC, e.g. `2026-09-18T01:12:44Z`                   |

The **story session** appends its own row, right after it creates or resumes the
tree — `run.sh` only tells it to (see the `prompt_for` line about appending
`"$1<TAB>path<TAB>branch<TAB>ISO time"`). The runner never writes this file
itself, because only the story session knows which of the three creation cases
below actually happened.

    printf '%s\t%s\t%s\t%s\n' "$ID" "$NIGHT_DIR/wt/$ID" "$BRANCH" \
      "$(date -u +%FT%TZ)" >> "$NIGHT_DIR/worktrees.tsv"

Rules the file obeys:

- **Append only.** A resumed story appends a second row for the same path; the
  cleanup de-duplicates by resolved path and keeps the first.
- **A row is a claim of ownership, nothing more.** `worktree-cleanup.sh` never
  touches a path that is not in this file, even if it sits in `wt/` and matches
  the naming scheme perfectly. Pattern matching is what destroyed the four files.
- **A missing file is not an error.** No rows means the run created no trees and
  there is nothing to clean.
- Lines beginning with `#` are ignored, so a note can be left in the file.

## 3. Creation — pick the case BEFORE running a command

`git fetch` first, then take exactly one of three cases. The case is *decided*
from the state of path and branch, never discovered from a failure: `git
worktree add -b` exits **255** when the branch already exists, and a session
that learns this from the error is one step from inventing a suffixed second
branch for the same story.

1. **Path exists** → do NOT recreate. Resume in it. A story session killed
   mid-flight (as S49 was on 2026-09-18) must be able to continue in its tree.
2. **Path missing, branch exists** (locally or on the remote) →
   `git worktree add "$NIGHT_DIR/wt/<id>" <branch>`. Attach the existing branch.
   Never create `<branch>-2`.
3. **Neither exists** →
   `git worktree add "$NIGHT_DIR/wt/<id>" -b <branch> origin/<BASE_BRANCH>`.
   From the **remote** base ref, never from whatever the local base branch
   happens to point at — a local `main` days behind origin silently bases the
   story on stale code.

Then append the `worktrees.tsv` row.

### Never

- **Never create a worktree inside the deployed tree.** There only worktree, tag
  and branch operations are permitted — no development, ever.
- **Never use bare `git stash` / `git stash pop`.** The stash stack is shared by
  every worktree of a repo, and other sessions pop it concurrently: a bare `pop`
  can restore someone else's changes into your tree, or hand yours to them.
  Set work aside with a **temporary WIP commit** instead:

      git add -A && git commit -qm "WIP <id> — parking"     # later: git reset --soft HEAD~1

  If a stash is truly unavoidable: `git stash push -u -m "<unique-tag>"`,
  capture the SHA immediately (`git stash list --format='%H %gs'`), restore with
  `git stash apply <sha>` (never `pop`), then drop that entry, re-finding its
  current `stash@{n}` by tag first.
- **Never touch a worktree this run did not create.** Another session or another
  project may be living in it.

## 4. Cleanup — PHASE F only

    bajzi/skills/night-run/worktree-cleanup.sh --config <config.env> [--apply] [--prune]

Cleanup runs in the morning phase, never mid-run. **It is a dry run by
default**: without `--apply` it decides and prints and removes nothing. A
cleanup tool that deletes by default is a bug, not a convenience.

For each recorded tree the script evaluates the rules in order and stops at the
first KEEP. Every KEEP line in the summary names the rule that produced it.

| rule | check | why it exists |
|------|-------|----------------|
| 0 | path is under `$NIGHT_DIR` | backstop against a mis-recorded row; the tool only removes trees the run owns |
| 1 | a live process has its cwd inside the tree, or one of a process's **argv words** is the tree or the branch | a tree in use is never removed; `/proc/*/cwd` plus `/proc/*/cmdline` split on NUL — **never `pgrep -f`**, see below |
| 1b | the story is PARKED or BLOCKED per its `RESULT` line, the night report, or a non-zero rc in `state.txt` | parked work is unfinished work |
| 1c/1d | not a usable git worktree, or checked out on a different branch than recorded | every check below would be answering about the wrong thing |
| 2a | the repository was located **and** `git fetch origin` succeeded in it | every rule below judges against `origin/*`; stale refs make "pushed" and "merged" meaningless |
| 2 | `git rev-parse --verify origin/<branch>` — **non-zero exit means KEEP** | see below; the most important rule in the file |
| 3 | `git status --porcelain --ignored=matching` **exits 0** and is empty, **and** `git cherry -v origin/<branch> HEAD` **exits 0** and lists no `+` commits | dirty or unpushed work is unrecoverable once the directory is gone |
| 4 | a MERGED PR exists for the branch: `gh` exits 0 **and** its first line is nothing but digits | unmerged work stays on disk; if `gh` cannot answer, that is a KEEP too |
| 5 | `git worktree remove <path>` — **without `--force`** | `--force` would delete a tree with modified tracked files. This is **not** a safety net, see below |

### Rule 2 must come first among the git checks

`git cherry -v origin/<branch> HEAD` against a branch that does not exist on the
remote **prints nothing and exits 128** (verified: `cherry rc=128`, zero bytes of
output). A cleanup that reads "empty cherry output means nothing unpushed" would
therefore conclude that a never-pushed branch is fully pushed and delete every
commit it has. So the branch's existence on the remote is checked first, and a
non-zero `rev-parse` stops the evaluation with KEEP.

### Rule 2a — the remote refs must actually be fresh

Rules 2, 3b and 4 all judge against `origin/*`, so a stale remote-tracking ref
turns "already pushed" and "already merged" into guesses — and it is the one
failure that leaves no trace in the output. The fetch is therefore decided and
remembered **per repository**: if the repository cannot be located, or
`git fetch origin` fails in it, every tree of that repository is KEPT and the
failure is printed. `--no-fetch` keeps every tree for the same reason; it is for
inspecting decisions offline, not for cleaning up. (The earlier code stored the
empty key `||` when the first repository lookup failed, and because every later
lookup matched that same `||`, the fetch was silently skipped for the whole
rest of the run.)

### Rule 3 uses `--ignored=matching` on purpose

Plain `git status --porcelain` reports a clean tree while a gitignored `.env`,
credentials file or local override sits in it — exactly the file whose loss is
unrecoverable. `--ignored=matching` lists it (`!! .env`), and the tree is kept.

### Empty output is not an all-clear — check the exit code

Every safety check reads the command's **exit code first** and its output
second. A failed git command prints nothing on stdout, and "nothing printed"
read as "nothing wrong" is how this tool destroys work:

- `git status --porcelain --ignored=matching` is a **hard error** when
  `status.showUntrackedFiles=no` is set in any repo, global or system gitconfig:
  `fatal: Unsupported combination of ignored and untracked-files arguments`,
  exit 128, zero bytes on stdout. Verified. Reading that as "clean" removed a
  tree whose only content was an untracked `analysis-notes.md` and `out/`, and
  the files were gone.
- `git cherry -v origin/<missing-branch> HEAD` behaves the same: nothing on
  stdout, exit 128.
- `gh pr list` prints an error body, not a PR number, when the API fails. Its
  first line must be **entirely digits** to count as a merged PR; squeezing the
  digits out of it (`tr -dc '0-9'`) turns `HTTP 502` into `PR #502 merged`.

So: a non-zero exit from any check means **the check could not be completed**,
which means KEEP, with the reason naming the failed command and its exit code.

### `git worktree remove` is NOT a backstop

The unforced form refuses a tree with **modified tracked files** — and nothing
else. It deletes a tree whose entire content is untracked or gitignored (that
local `.env`) and exits 0; verified during review. And the same
`status.showUntrackedFiles=no` that breaks rule 3 also silences `git worktree
remove`'s own internal check, so both fail together. `--force` stays forbidden,
but rule 3 — our own status call with its exit code checked — is the **only**
real guard on this path. Never weaken it on the theory that git will catch it.

### Rule 1 does not use `pgrep -f`

`pgrep -f <branch>` matches an unanchored regex against the whole flattened
command line, so it matches the shell that is *running the cleanup* (the branch
and path are its own arguments), plus any grep, editor or log tail that merely
mentions the name. Measured during review: 5 matches out of 5 runs were the
reviewer's own shell — the verdict was noise, and noise that always says "in
use" trains the operator to ignore rule 1. The project already solved this for
the runner lock (spec section 5): read `/proc/<pid>/cmdline`, split on NUL and
compare **whole argv words**. A process that merely mentions the name carries it
inside a `-c` string, not as an argv word. If procfs cannot be read at all, the
answer is "in use" — the check that cannot be performed fails towards KEEP.

### After the removals

- `git worktree prune` does **not** run by default. It is repo-wide and there is
  no per-project form: it walks every worktree registered in that repository and
  de-registers each one whose directory it cannot see, including another
  project's and another session's **live** trees — it de-registered exactly such
  a live worktree during review, and the innotel-bss night runner shares its
  repository with trees like that. A successful `git worktree remove` already
  removes its own administrative directory, so there is nothing left to prune.
  The `--prune` flag exists for a repository with known-stale metadata and is
  the owner's deliberate call; it only ever runs in a repository this run
  actually removed a tree from.
- A `GONE` row (recorded path already deleted) contributes nothing to that list:
  the parent of a missing tree is `$NIGHT_DIR/wt`, a plain directory and never a
  repository.
- **Branches are never deleted.** Merged branches are printed as a suggestion;
  deleting one is the owner's call, taken with the PR in front of them.
- A recorded path that no longer exists is reported `GONE`, not an error.

### Exit status

| code | meaning |
|------|---------|
| 0 | nothing was kept that the owner has to look at |
| 1 | at least one tree was kept dirty, unpushed, parked or blocked — PHASE F lists these in the report under "what the owner should look at" |
| 2 | usage or config error |

So a caller can branch on "needs attention" without parsing the table.

### The rule behind all the rules

Losing uncommitted work to a tidy-up is strictly worse than leaving a directory
on disk. Disk is cheap and the owner can delete a tree in one command; the four
files destroyed on 2026-09-18 are gone for good.
