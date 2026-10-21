# Slice format

The contract between `/bajzi:implement` and the `implementer`/`implementer-risk` agents.
`/bajzi:implement` parses the file with `bajzi/lib/findings-cli.js slice <id>`.

## Slice file

One file per slice: `runtime/slices/<slice-id>.md`. The id is the filename without `.md`, and must match `^[a-z0-9][a-z0-9-]{0,63}$` (`findings-cli.js` refuses any other: ids become paths and commit messages). `debt` is reserved
for the debt drain (`debt.md`, `debt-r2.md`) and refused as a slice id.

```
# Slice · cart-coupon
tier: 2
files: cart.js, cart.test.js
acceptance: applyCoupon caps the discount at 50% of the total, for any input percent
test: node --test
```

- Title: `# Slice · <slice-id>`, matching the filename.
- Fields, all mandatory, one per line (`key: value`):
  - `tier`: `1`, `2` or `3` (see the change map in `docs/bajzi-package-spec.md` §2; Tier 1 = locks, concurrency, quotas,
    auth, money, migrations, destructive scripts; file count alone is not Tier 1).
  - `files`: comma-separated paths the agent may touch — the ownership boundary: the agent edits
    exactly these, in any directory (`docs/**` included, so a Tier-3 docs slice goes through the
    agent too), and never `runtime/**`, guard files, hooks, settings or `.githooks/**`.
    Anything else needed is a `BLOCKED`.
  - `acceptance`: what must be true when the slice is done, in plain language.
  - `test`: the command that proves it (`none` only for slices with nothing to test).
    `findings-cli.js slice` prints `none` as `test: skip`: /bajzi:implement and /bajzi:fix then run
    no test (the bajzi gate still runs on the commit).

## Dispatch (`/bajzi:implement`)

`tier: 1` dispatches `implementer-risk` (opus); `tier: 2` or `3` dispatches `implementer`
(sonnet). The skill passes only the slice spec — not surrounding context — so the
Tier-1 → opus rule is a lookup against the file, never something the orchestrator has to remember.

## Plan -> slices

A session turns an approved plan file into slices by this rule (no script):

- One slice per plan task (`### Task N` heading).
- id `<plan-stem>-t<N>`, lowercase, inside the id regex; truncate the stem so the id fits 64 chars.
- `tier` 1 when the task touches locks, concurrency, quotas, auth, money, migrations or
  destructive scripts, else 2 (docs-only task: 3).
- `files` = the task's Files list (create/modify/test).
- `acceptance` = the task's expected result / goal line.
- `test` = the task's test command (`none` when it has none).
- Two tasks touching the same file run sequentially, never in parallel.
- A task without a Files list is BLOCKED.
- Each closed task gets its checkbox ticked in the plan file.

## Agent report

This is the one canonical report format; the agent bodies (`bajzi/agents/implementer*.md`) and
`bajzi/tests/agents/contract-implementer.test.js` follow it. The agent's final message ENDS
with exactly one of:

```
SLICE <slice-id> DONE
<file>
<file>
```
```
SLICE <slice-id> BLOCKED: <one line>
```

`DONE` lists every file the agent changed, one bare path per line, after the status line, and
nothing follows the list. `BLOCKED` is the last line and carries no file list — the caller stops
and reports the block to the owner. Anything before the `SLICE` line (the last lines of the test
run, as evidence) is not part of the report; the caller reads from the `SLICE` line on.
