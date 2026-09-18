# /bajzi:night-run — design

Date: 2026-09-18
Status: approved by the owner, ready for an implementation plan
Scope: a new skill `bajzi/skills/night-run/` that plans and drives a multi-hour
unattended overnight autopilot run for any project on this machine.

## 1. Why

The innotel-bss overnight runs of 2026-09-17 and 2026-09-18 worked: one fresh
headless Claude session per story, a merge gate, a morning report. All of it
lives in hand-written, innotel-bss-shaped files under `/home/ubuntu/night/`
(`BRIEF.md`, `queue.txt`, `run.sh`). Running a night on a second project today
means copying and editing three files by hand and re-deriving the rules from
memory.

This spec turns that into one reusable skill plus one shared runner, so a night
run is configuration, not a rewrite.

## 2. Invocation

    /bajzi:night-run project:<name>              plan tonight's run
    /bajzi:night-run project:<name> model:opus   Opus 5 orchestrator
    /bajzi:night-run project:<name> hours:6      fit the queue to a 6 h window
    /bajzi:night-run project:<name> status       is a run alive, and where
    /bajzi:night-run project:<name> report       morning follow-through

`project:` resolves to a repo the Brain knows (`brain next <project>`); if it
does not resolve, the skill stops and lists the projects the Brain does know.

`model:` chooses the per-story ORCHESTRATOR session only:

| value              | model id              | when                         |
|--------------------|-----------------------|------------------------------|
| omitted (default)  | `claude-fable-5-1`    | normal                       |
| `model:opus`       | `claude-opus-5`       | the Fable budget is used up  |

Each story session still picks its own sub-agent models itself, per the model
policy section of the rendered BRIEF.

`hours:` defaults to 8. It sizes the queue, it does not hard-stop the run; the
runner's own `--deadline` is the hard stop.

## 3. Files

Shipped in the plugin (project-agnostic, never edited per project):

    bajzi/skills/night-run/
      SKILL.md
      run.sh                       THE runner
      templates/
        BRIEF.md.tmpl
        NIGHT-RULES.md.tmpl
        config.env.tmpl
        settings.local.json.tmpl

Generated per project, outside the repo:

    ~/night-runs/<project>/
      config.env                   repo path, base worktree, base branch, model, timeout
      queue.txt                    <id>|<slug>|<needs>|<note>
      BRIEF.md                     rendered from the template + docs/NIGHT-RULES.md
      state.txt                    <id> <rc> <ISO time>
      run.lock                     advisory lock holding the runner's pgid
      worktrees.tsv                <id> <path> <branch> <created ISO>
      wt/<id>/                     one git worktree per story (section 8)
      logs/                        <id>.log, runner.log, console.log, report.log
      REPORT-<date>.md
      STOP                         kill switch, checked between stories

The generated allowlist is installed as `<BASE>/.claude/settings.local.json`,
i.e. into the base worktree named by `config.env`, which is the directory every
story session is started from. It is not per-story.

Committed in the project repo, owned by the owner:

    docs/NIGHT-RULES.md            the per-project rules the skill cannot derive

`~/night-runs/<project>/` is chosen over the existing flat `/home/ubuntu/night/` so
two projects can hold state at once.

## 4. docs/NIGHT-RULES.md

The one input a night run cannot derive from code or the Brain. Read in PHASE A;
if missing, the skill scaffolds it from the template, shows it to the owner and
stops. Sections:

1. Base branch and merge policy — may the run squash-merge its own green PRs?
2. Forbidden stories — ids the run must never pick up, with the reason.
3. Forbidden paths — e.g. `.github/**`, secrets, another product's tree.
4. Migration policy — e.g. numbers only via `~/innotel-pm/MIGRATION-LEDGER.md`.
5. CI facts — the NAME of the required check, which run event satisfies it
   (for innotel-bss only a `pull_request`-event run counts), known tooling
   quirks such as `gh pr checks` failing with the configured token.
6. Post-merge invariants — commands that must pass after every merge to base.
7. Machine neighbours — containers, ports and trees this project must not touch.
8. Resource floors — minimum free disk in GB below which a run must not start,
   and any other machine limit this project is known to hit.

## 5. Phases

### PHASE A — Preflight

Refuse to plan if a run is already alive for this project.

- Detect with `pgrep -af "bash .*/run\.sh$"`, NEVER with a bare `ps`. The `$`
  anchor is load-bearing: an unanchored pattern also matches the wrapper process
  running the check itself, which reports phantom extra runners. This was
  observed, not theorised — the unanchored form returned three pgids for one
  live runner. On this
  machine `rtk` rewrites `ps`, the output format changes, and a pattern match
  silently finds nothing — which on 2026-09-18 made a healthy runner look dead
  and nearly caused a second one to be started. The skill states this trap in
  one line.
- One runner = ONE distinct pgid among the matches; the parent plus its subshell
  are two processes in one group. Compare pgids, not process counts. `pgrep -af`
  cannot print pgids (`-g` matches them, it never displays them), so read them
  from procfs, which `rtk` does not touch:

      for p in $(pgrep -f "bash .*/run\.sh$"); do awk '{print $5}' /proc/$p/stat; done | sort -u

  More than one line means more than one runner: stop and report, never launch.
  Verified against the live 2026-09-18 runner: one line, `1453420`.
- Cross-check `run.lock`: if it holds a pgid that is still alive, a run is live.
- `git fetch`, then confirm the base branch is not behind its own remote.
- Disk headroom check; refuse below `DISK_FLOOR_GB`. On this VM the build cache
  has filled the root filesystem twice, so this check is not decorative.
- Is the base branch red? Determined by the latest run of `REQUIRED_CHECK` on
  the base branch. If red, report it as the top blocker and do not queue filler
  work around it.
- Read `docs/NIGHT-RULES.md`; scaffold and stop if absent.

### `status` mode

A read-only subset of PHASE A, safe to run at any time, including while a run is
live. It prints: whether a runner is alive and its pgid, the current story and
how long it has been running, the tail of `runner.log`, the `state.txt` rows so
far, open PRs for the project, and free disk. It changes nothing, creates
nothing and never launches anything.

### PHASE B — Collect

Sources, in precedence order:

1. `brain next <project> --sessions 5` — open threads: id, branch, title,
   status, last touched. The primary well.
2. `docs/BACKLOG.md` — size S/M/L, coding %, testing state, depends-on. Sizing
   and dependency data.
3. `gh pr list --state open` — PRs left open by earlier runs. These become
   follow-up items, not new stories.
4. The previous `REPORT-<date>.md` — PARKED and BLOCKED entries, with the reason
   that parked them, as retry candidates.

Then subtract everything `docs/NIGHT-RULES.md` forbids. Explicitly NOT a source:
TODO/FIXME scanning and lint debt — it maps to no milestone and burns a slot.

### PHASE C — Plan

- Respect `depends-on`; a story whose dependency is unmerged is skipped forward,
  never reordered upwards.
- Prefer file-disjoint neighbours so consecutive stories do not fight over the
  same files.
- Fit sizes to `hours:` using the budget below, which is the observed cost of a
  story session on the two innotel-bss nights, not a guess at ideal effort:

      S = 1 h    M = 2 h    L = 3 h    unsized = treated as M

  `PER_STORY_TIMEOUT` remains the hard per-story cap. Queue until the budget is
  spent, then list what did not fit as deferred WITH the reason; never drop an
  item silently.
- Write `queue.txt`; render `BRIEF.md` from the template plus NIGHT-RULES.

### PHASE D — Approval gate

One screen, the only question the skill asks:

- the ordered queue, each item with its size and one line of why it is in;
- what the run may merge into the base branch unattended, and the reminder that
  every item passes the section 10 review loop before it can be merged;
- what was deferred and why;
- any blocker found in PHASE A.

The owner approves or edits once. The gate is not optional: the run merges to
the base branch for hours while the owner sleeps.

### PHASE E — Launch (owner step)

A Claude session is blocked by the auto-mode classifier from starting the runner
(Interfere With Workloads), so the skill never launches it. It emits a numbered,
copyable command block per the owner's rules in CLAUDE.md: the machine and
shell, the working directory, one command per line, success criteria, and the
single likeliest failure with its fix. The block covers:

1. install the generated allowlist into the night worktree;
2. launch: `setsid nohup bash run.sh ... &`;
3. verify: `pgrep -af "bash .*run.sh"` shows ONE distinct pgid.

`setsid` is required, not cosmetic. On 2026-09-18 the runner was started with
`nohup` alone and died with the session that launched it — `nohup` blocks SIGHUP
but not the harness killing the launching session's process group. `setsid`
gives the runner its own session, so it survives.

### PHASE F — Morning follow-through (`report` mode)

- Read `REPORT-<date>.md` and `state.txt`.
- Review every PR still open with one Opus sub-agent each, using the section 10
  verdict format; never review in the main thread.
- Merge only PRs that are both review-green and CI-green, under the NIGHT-RULES
  merge policy. A PR the night parked for review is re-reviewed here, not
  waved through because it is morning.
- Run the post-merge invariants from NIGHT-RULES after each merge.
- Clean up the run's worktrees per section 8 — dirty or parked trees are kept,
  not removed.
- Refresh the project's deck and update the owner's single runbook list in
  place — never publish a second list.

## 6. The runner

`run.sh` is the current `/home/ubuntu/night/run.sh` with its innotel-bss
constants lifted into `config.env`: `NIGHT_DIR`, `BASE`, `REPO`, `BASE_BRANCH`,
`MODEL`, `PER_STORY_TIMEOUT`, `PROJECT`, `BRANCH_PREFIX` (e.g. `bss`, used to
build `feat/<prefix>-<id>-<slug>`), `DISK_FLOOR_GB` and `REQUIRED_CHECK` (the
name of the CI check that must be green). Behaviour that stays exactly as proven
tonight: one fresh `claude -p` per queue line, `--permission-mode auto` plus the
generated allowlist, `timeout` per story so a hung story cannot eat the night,
the `STOP` kill switch checked between stories, and a final fresh session that
writes the report. The queue is walked twice: pass two picks up only items never
started and items whose `needs:` dependency became satisfied during pass one. A
story that ran and failed is NOT retried the same night — it is reported, and
re-queued by the next `/bajzi:night-run`.

Changes to the runner, all of them fixes found tonight:

- a `needs:` dependency may name any PR, not the hard-coded `pr115`;
- an advisory lockfile carrying the pgid, next to the `pgrep` check;
- `--deadline` accepts a full timestamp, not only a morning `HH:MM`.

## 7. Rules carried into the rendered BRIEF

The ruleset established over the two innotel-bss nights, templated:

- Context discipline: the story session is an orchestrator. Sub-agents do every
  heavy step; never read a file over 300 lines in the main thread.
- Per-story recipe: own worktree created off the remote base ref per section 8,
  TDD, one PR per story; resume in the tree if it already exists.
- Review loop: every story ends in the independent Opus review-and-fix loop of
  section 10, capped at 3 rounds. Nothing is reported done without a review-green
  verdict.
- Merge gate: only a `pull_request`-event CI run counts; merge the base branch
  into the branch first; run the post-merge invariants; squash-merge only when
  the run is BOTH review-green and CI-green; otherwise leave the PR open and
  PARK it with a reason.
- Model policy: orchestrator per `model:`, sub-agent models chosen per task.
- Never ask questions — the owner is asleep. Park instead of guessing.
- Never develop in the deployed tree.
- Finish with one machine-readable line:
  `RESULT <id> <state> PR#<n> review=<pass|parked> rounds=<n>`.

## 8. Worktree lifecycle

Each story gets its own git worktree, and the run owns every tree it creates
from birth to cleanup. Tonight's runs proved both halves of this matter: stories
ran fine in per-story trees, but the trees piled up flat in `$HOME`, and a later
cleanup session removed 18 of them and destroyed four uncommitted files in one.

### Location and naming

    ~/night-runs/<project>/wt/<id>/        e.g. ~/night-runs/innotel-bss/wt/S49/

Night worktrees live under the project's night directory, not loose in `$HOME`.
Cleanup is then scoped by construction: anything under `wt/` belongs to this
project's night runs and nothing else does. Branch name stays
`feat/<project-prefix>-<id>-<slug>`, taken from `config.env`.

### Creation

`git fetch` first, then take exactly one of three cases. `git worktree add -b`
exits non-zero when the branch already exists, so the case must be chosen before
the command runs, not discovered from a failure:

1. Path exists → do NOT recreate. Resume in it. A story session killed
   mid-flight (as S49 was on 2026-09-18) must be able to continue.
2. Path missing, branch already exists (locally or on the remote) → attach it:
   `git worktree add <path> <branch>`. Never invent a suffixed second branch.
3. Neither exists → create from the REMOTE base ref, never from whatever the
   local base branch happens to point at:
   `git worktree add <path> -b <branch> origin/<base_branch>`.
- Record every tree the run creates in `~/night-runs/<project>/worktrees.tsv`
  (`<id>	<path>	<branch>	<created ISO>`), so morning cleanup is
  deterministic instead of a `$HOME` pattern match.

### Never

- Never create a worktree inside the deployed tree. There, only worktree, tag
  and branch operations are permitted — no development, ever.
- Never use bare `git stash` / `git stash pop`. The stash stack is shared across
  every worktree of a repo and other sessions pop it concurrently. Set work
  aside with a temporary WIP commit instead. If a stash is truly unavoidable:
  `git stash push -u -m "<unique-tag>"`, capture the SHA immediately, restore
  with `git stash apply <sha>`, then drop that entry by tag.
- Never touch a worktree this run did not create — another session or another
  project may be living in it.

### Cleanup, in PHASE F only

Cleanup runs in the morning phase, never mid-run, and never against a tree that
a process is still using.

For each tree in `worktrees.tsv`:

1. Is a live process using it? `pgrep` for the story session and check no
   process has its cwd inside the tree. If in use: skip, report it.
2. Does the branch exist on the remote at all?
   `git rev-parse --verify origin/<branch>` — a non-zero exit means the branch
   was never pushed, so KEEP the tree and stop evaluating it. This check must
   come first: `git cherry -v origin/<missing-branch> HEAD` prints NOTHING and
   exits 128, so a rule that reads "empty output means nothing unpushed" would
   delete every commit of a never-pushed branch.
3. Is it clean? `git status --porcelain --ignored=matching` must be empty, and
   `git cherry -v origin/<branch> HEAD` must list no `+` commits. Plain
   `--porcelain` hides ignored files, and a local-only `.env` or credentials
   file is exactly the kind of thing whose loss is unrecoverable.
4. Was its PR merged? Only then `git worktree remove <path>` — WITHOUT
   `--force`. The unforced form refuses to delete a tree with changes in it and
   is the last backstop after every check above; passing `--force` removes the
   backstop and is forbidden.
5. Anything dirty, unpushed, PARKED or BLOCKED is KEPT, and listed in the report
   under what the owner should look at. Losing uncommitted work to a tidy-up is
   strictly worse than leaving a directory on disk.
6. `git worktree prune` only after the removals, and only for this project.

Branches are never deleted by the run. Deleting a merged branch is the owner's
call, taken with the PR in front of them.

## 9. Context discipline and sub-agent use

The unit of context is ONE STORY, never the night. `run.sh` starts a fresh
`claude -p` per queue line, so a 6-hour run is N independent contexts that each
begin empty. The design requirement that follows is narrow and checkable: one
story must fit in one context. Everything in this section serves that, and the
rendered BRIEF states it to every story session verbatim.

### What the story session may do itself

It is an orchestrator, not a worker. In its own context it may only:

- read and write the small run files (its handoff, its report section);
- run git and gh commands whose output is a few lines;
- dispatch sub-agents and record their compact results;
- take the merge-gate decision.

### What must always be delegated

| work                        | model      | must return                              |
|-----------------------------|------------|------------------------------------------|
| locate code, explore layout | Haiku      | paths plus <= 10 lines, no file contents |
| implement a slice, TDD      | run model  | files changed, test counts, <= 15 lines  |
| run a test suite            | Haiku      | pass/fail counts, failing test names only|
| review a diff               | Opus, always | the section 10 verdict, <= 20 lines    |
| fix review findings         | run model  | what changed, <= 10 lines                |
| write a document > 100 lines| Sonnet     | the path plus <= 5 lines                 |

Every dispatch prompt ends with an explicit line budget and the sentence: never
paste file contents, raw test output or diffs into your report. Without that
line sub-agents return transcripts and the whole saving is lost.

### Never in the story session's own context

- Full test suite output. Delegate, or use the compressing wrapper.
- `gh run view --log`. Use `--json status,conclusion` instead; CI logs are the
  single largest context sink in this workflow.
- `git diff` across more than a couple of files. Use `--stat`, then delegate.
- Any file over 300 lines.
- Directory listings of `node_modules`, `dist` or build output.

### Chunking is the orchestrator's job

Do not hand one sub-agent an entire story and hope it copes. A sub-agent that
overflows its own context fails late and its work is lost, which costs a whole
story slot. Split the story into slices that each fit comfortably, and assume a
sub-agent CANNOT spawn sub-agents of its own — plan the split at the top.

### Self-monitoring and graceful park

A story session watches its own usage and degrades deliberately rather than
thrashing:

- at roughly half its context: stop taking new scope, finish the current slice;
- at roughly 70%: finalize — commit what is green, push, open or update the PR,
  write the handoff, emit `RESULT <id> parked PR#<n>` with reason `context`,
  and exit cleanly.

A story parked for context is re-queued the next night and resumes in its
existing worktree per section 8, with the handoff telling it where it stopped.
This is a normal outcome, not a failure, and the report distinguishes it from a
story parked for a red CI run.

### Why the report is a separate session

The night report is its own fresh `claude -p` after the last story, so
consolidating a night's worth of results never competes with story work for
context. PHASE F in the owner's morning session follows the same rules: one
sub-agent per PR review, never a review in the main thread.

## 10. The review-and-fix loop

No story is ever reported done on the implementer's word. Every development
story ends in a loop driven by the orchestrator, in which an INDEPENDENT Opus
sub-agent reviews the work and the loop repeats until the review comes back
clean. This is the difference between a night run that produces PRs and one that
produces correct PRs.

### Roles, and why they are separate agents

| role        | model                    | sees                                   |
|-------------|--------------------------|----------------------------------------|
| implementer | the run model            | the story, the code                    |
| reviewer    | Opus 5, ALWAYS           | the diff and the acceptance criteria   |
| fixer       | the run model            | the findings, the code                 |

- The reviewer is **always Opus 5**, even when `model:opus` already makes the
  orchestrator Opus. Independence here means a separate context that never saw
  the implementer's reasoning — not a different model name.
- The reviewer reviews **the diff against the base ref**, never the
  implementer's summary of it. An agent grading its own homework from its own
  notes is not a review.
- The fixer is never the reviewer. A reviewer that fixes its own findings
  reviews its own work in the next round.
- Each round gets a FRESH reviewer. It receives the previous round's findings
  as a checklist to verify as fixed, not as a conclusion to trust.

### The loop

1. Implementer finishes a slice; tests pass locally.
2. Orchestrator dispatches a reviewer with: the story id and its acceptance
   criteria from the queue note, the base ref, and the previous round's findings
   if any. The reviewer reads the diff itself.
3. Reviewer returns a structured verdict, at most 20 lines:

       VERDICT <pass|fail>  ROUND <n>
       BLOCKING  <n>   - one line each: file:line, what is wrong, why it matters
       NON-BLOCKING <n> - one line each
       EVIDENCE: tests run and their counts, files actually read

   "Looks good" is not a verdict. A pass with no evidence line is treated as a
   fail and the round is re-run.
4. BLOCKING findings > 0 → orchestrator dispatches a fixer with the findings,
   then returns to step 2 with a fresh reviewer.
5. BLOCKING findings = 0 → the story is review-green. Non-blocking findings are
   recorded in the PR body and the night report; they never gate the loop, or a
   nitpick would keep the story spinning until the timeout.

### Green means two things

- **review-green**: an independent Opus reviewer returned zero blocking findings.
- **CI-green**: the required `pull_request`-event check passed.

Both are required. review-green gates the PR being offered for merge; CI-green
gates the merge itself (section 5, merge gate). A story that is CI-green but not
review-green is NOT merged and NOT reported done.

### Forbidden ways to reach green

The fixer may not make a finding disappear by weakening what detects it.
Specifically forbidden: deleting or skipping a failing test, loosening an
assertion, widening a type to silence a checker, catching and swallowing an
error, or lowering a coverage or lint threshold. If a finding is genuinely
wrong, the fixer says so with its reasoning and the orchestrator decides,
records the decision with `brain note decision:`, and the decision goes in the
report. Disagreement is resolved on the technical merits and recorded — never by
silent compliance and never by deleting the check.

### Termination — the loop must end

"Loop until everything is green" needs a floor, or a story eats the night:

- **Maximum 3 review rounds.** Still blocking after round 3 → the story is
  PARKED, not merged, not reported done. The PR stays open with the outstanding
  findings in its body, and the report lists it first under what the owner
  should look at.
- The loop is also bounded by `PER_STORY_TIMEOUT` and by the context park
  thresholds in section 9. Whichever floor is hit first wins, and the park
  reason names which one it was: `review`, `timeout` or `context`.
- A reviewer that returns the same blocking finding twice with no change in the
  diff means the fixer is stuck. Do not spend round 3 on it — park immediately
  and say so.
- Parked-for-review is a normal outcome. It is re-queued the next night and
  resumes in its existing worktree with the findings in the handoff.

### What the orchestrator must never delegate

The orchestrator dispatches the agents, reads their compact verdicts and takes
the decision itself. It never lets a sub-agent decide that a story is done, and
it never writes a `RESULT` line from an implementer's claim. The result line
carries the evidence:

    RESULT <id> <merged|open|parked|blocked> PR#<n> review=<pass|parked> rounds=<n>

A story reported `merged` or `open` with `review=parked` is a contradiction the
report must flag.

### Cost

Each round is a fresh sub-agent, so the loop costs the orchestrator only the
verdicts — roughly 20 lines per round, three rounds at worst. The loop is
therefore compatible with section 9: it buys correctness without growing the
orchestrator's context.

## 11. Out of scope

TODO/FIXME mining; more than one project per night; a systemd timer or
scheduler; changing the classifier's behaviour. The owner launches at bedtime.

## 12. Migration of innotel-bss

`/home/ubuntu/night/` is in use by a live runner and is not touched while it
runs. After the queue finishes, innotel-bss moves to `~/night-runs/innotel-bss/` with
its current `queue.txt` and a `docs/NIGHT-RULES.md` written from tonight's
owner rulings. Tonight's existing `/home/ubuntu/bss-S*` worktrees are recorded
into `worktrees.tsv` during migration rather than being recreated, so the
morning cleanup rules apply to them too. The old directory is kept until one
full night has run on the shared runner.
