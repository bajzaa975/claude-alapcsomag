# bajzi pre-commit gate

Source `bajzi/gate/pre-commit.js` (Node, no dependencies). `/bajzi:project-setup` copies it
verbatim to `<repo>/.githooks/pre-commit` when the repo's `.claude/project-profile.json` has a
`gate` key. Edit the source, never the copy; `project-setup --check` reports a differing copy as
`DRIFT gate .githooks/pre-commit`.

## What runs

| Tool | Scope | Needed when | Effect |
|---|---|---|---|
| `gitleaks protect --staged --redact --no-banner` | staged diff | always (if in `tools`) | exit 1 = block; other non-zero = tool error |
| `ruff check -- <staged .py>` | staged files | a `pyproject.toml` owns the file | exit 1 = block; other non-zero = tool error |
| `eslint -- <staged .js/.jsx/.ts/.tsx>` | staged files | a `package.json` owns the file | exit 1 = block; other non-zero = tool error |
| `pyright --outputjson` | project-wide, per `pyproject.toml` dir | that dir exists | `summary.errorCount` summed; block if > baseline `pyright` |
| `tsc --noEmit --pretty false` | project-wide, per `package.json` dir that also has `tsconfig.json` | that dir exists | located `file(l,c): error TSnnnn:` lines summed; block if > baseline `tsc`; any `error TS` line without a location (a config/global error such as TS5058) = tool error |

- **Project dirs** are the repo root and its immediate subdirectories (not dot-dirs, not
  `node_modules`) holding the marker file. A staged file belongs to the deepest one containing it;
  the tool runs with that dir as cwd and dir-relative paths. A file no project owns is not linted;
  the hook names it (`gate: ruff: not linted, no pyproject.toml dir owns: ...`).
- **Tool lookup**: `<dir>/node_modules/.bin`, `<dir>/.venv/Scripts` (Windows) or `.venv/bin`, then
  `PATH`. `.cmd`/`.bat` shims run through the shell with every token quoted.
- **Absent stack** (no marker file) = skipped with one log line per tool (`gate: <tool> skipped (no
  <marker> ...)`), never a block. **Needed but missing** =
  exit 2 with the install line (`HINTS` in the source; `manifest.json` `gate_tools` carries the
  same lines, asserted by the test).
- **Ratchet**: a count equal to the baseline passes; above blocks; below rewrites the baseline
  (other keys kept) and `git add`s it, so the improvement lands in the same commit. The rewrite
  happens only when nothing else blocked. A missing/unreadable baseline, or one without the key
  for a tool in scope, is exit 2 ("run --init").
- **Pathspec commits** (`git commit -- <paths>`) run the hook on a temporary index
  (`GIT_INDEX_FILE` is neither `.git/index` nor `.git/index.lock`). A `git add` there would commit
  the rewrite but leave the old baseline staged in the real index, so the hook skips the rewrite,
  prints `baseline rewrite deferred`, and passes; the next normal commit ratchets.
- A non-zero ratchet run with no readable count (unparsable JSON, `tsc` with no located
  `error TS` line) is a tool error, never a pass.
- **Partial staging**: a staged `.py`/`.js`/`.jsx`/`.ts`/`.tsx` file that also has unstaged changes
  is exit 2 naming the file (ruff/eslint read the working tree, so the staged content would go
  unjudged). Stage or stash the rest, then commit.

## Exit codes

`0` clean, `1` blocked, `2` tool error or a needed tool missing (also blocks). All tools run, the
worst result wins. Callers read the exit code only, never the console text (the RTK lesson).

## Configuration (`.claude/project-profile.json`)

```json
{ "gate": { "tools": ["gitleaks", "ruff", "eslint", "pyright", "tsc"], "baseline": ".gate-baseline.json" } }
```

`tools` narrows the set (non-empty, distinct, from the five); `baseline` is repo-relative. With no
`gate` key the hook runs all five with the default baseline. An unreadable profile is exit 2.

## Install and init (once per repo)

1. `git config core.hooksPath .githooks` (project-setup refuses without it).
2. Add `gate` to the profile, run `/bajzi:project-setup`. It refuses to overwrite a
   `.githooks/pre-commit` that is not the bajzi gate (marker `bajzi:gate`); move that one away.
3. `node .githooks/pre-commit --init` writes the baseline from today's counts. Commit it with the
   hook, staged executable: `git add --chmod=+x -- .githooks/pre-commit` (a plain Windows
   `git add` stages mode 100644, and Linux/mac checkouts then skip the hook). Once the hook is
   tracked, `/bajzi:project-setup` sets the index mode itself (`git update-index --chmod=+x`), and
   `--check` reports a 100644 entry as `DRIFT gate-mode .githooks/pre-commit`.

## Limits

- It lints the working-tree copy of each staged file, which is why a partially staged lint file
  is refused (exit 2) rather than judged.
- It is a discipline gate, not a security boundary: `git commit --no-verify`, a profile edit or a
  baseline edit bypasses it. The skills never pass `--no-verify`.
- Windows: the hook's `#!/usr/bin/env node` needs Git's `usr/bin` on the hook's PATH, which a
  normal Git for Windows install (the `cmd/` wrapper, or Git Bash) provides.
