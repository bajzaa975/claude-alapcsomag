# Slice format

The contract between `/bajzi:implement` (T5) and the `implementer`/`implementer-risk` agents
(`docs/superpowers/plans/2026-09-bajzi-agents-and-cadence-plan.md` §4.1, §4.3). No parser ships
in this task (T4) — `/bajzi:implement` reads the file directly when it lands in T5.

## Slice file

One file per slice: `runtime/slices/<slice-id>.md`. The id is the filename without `.md`.

```
# Slice · cart-coupon
tier: 2
files: cart.js, cart.test.js
acceptance: applyCoupon caps the discount at 50% of the total, for any input percent
test: node --test
```

- Title: `# Slice · <slice-id>`, matching the filename.
- Fields, all mandatory, one per line (`key: value`):
  - `tier`: `1`, `2` or `3` (plan §2 change-map semantics; Tier 1 = locks, concurrency, quotas,
    auth, money, migrations, destructive scripts, or ≥ 3 files).
  - `files`: comma-separated paths the agent may touch. Anything else needed is a `BLOCKED`.
  - `acceptance`: what must be true when the slice is done, in plain language.
  - `test`: the command that proves it (`none` only for slices with nothing to test).

## Dispatch (`/bajzi:implement`, T5)

`tier: 1` dispatches `implementer-risk` (opus); `tier: 2` or `3` dispatches `implementer`
(sonnet). The skill passes only the slice spec — not the plan, not surrounding context — so the
Tier-1 → opus rule is a lookup against the file, never something the orchestrator has to remember.

## Agent report

The agent's final message is exactly one of:

```
SLICE <slice-id> DONE
<file>
<file>
```
```
SLICE <slice-id> BLOCKED: <one line>
```

`DONE` lists every file the agent changed, one per line, after the status line. `BLOCKED` carries
no file list — the caller stops and reports the block to the owner.
