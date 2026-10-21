---
name: project-setup
description: Apply or check this repo's project profile (.claude/project-profile.json), incl. start assessment, project size and hosting — project-scope plugins, project .mcp.json entries, .claude/METHODOLOGY, linked skills, instruction files and the bajzi pre-commit gate. Use it when the user says "project-setup", "set up this repo from its profile", "apply the project profile", or with --check ("is this repo in sync with its profile").
---

# Project setup from the repo's profile

The project's desired state is `.claude/project-profile.json`, committed in the repo. bajzi
supplies only the mechanism, `${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js`. Never
edit the profile to make a run pass, with two exceptions: the start assessment below writes
size/hosting (and gate for M/L), and an owner-approved size upgrade changes size (and adds gate).
If the profile is otherwise wrong, tell the user.

## `--check`

Run exactly:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js" --check
```

Print the output verbatim. Exit 0 = `project-setup --check: clean` (or no profile: nothing to do).
Exit 1 = one `DRIFT <kind> <target>` line per item. Exit 2 = the profile was REFUSED (unknown
key, newer version, invalid value): print the reasons, change nothing.

## Start assessment

Run when `.claude/project-profile.json` is missing or has no `size` or no `hosting`, and never under `--check`
(it changes nothing).

1. Not a git work tree -> do NOT run `git init`; `## Apply` does it (with `core.hooksPath .githooks`).
2. Ask ONE round, all five at once, each with a recommended answer from what the folder shows:
   1. Is this a general repo for mixed small asks and questions (no single product)? (yes -> XS; skip 2-4)
   2. Will it be deployed anywhere (server, VM, store, another machine), used by anyone else, or handle personal data or money? (yes -> at least M)
   3. Will it have production users with a release cycle? (yes -> L)
   4. More than one developer, or more than one service or repo? (yes -> L)
   5. May the code and its data be uploaded to GitHub? (no or unsure -> hosting local; yes -> github)

   Size = the highest size any answer gives; none -> S. Hosting is independent of size.
3. Write the keys into the profile (create `{ "version": 1, ... }` when missing; keep every other key). For M/L
   without `gate`: add `"gate": {"tools": [...]}` - always `gitleaks`, plus `ruff`/`pyright` when a `pyproject.toml`
   exists and `eslint`/`tsc` when a `package.json` (+ `tsconfig.json` for tsc) exists.
4. Show the profile diff, then continue with `## Apply`.

## Size upgrade

The project's `.claude/CLAUDE.md` kit block lists the size triggers, checked before every new plan. When one
fires: propose the new size in one line with the trigger; only after owner OK change `size` (add `gate` for M/L
as in step 3) and run `## Apply`. Upgrades only add files; downgrades delete nothing.

## Apply

1. `git status --short -- .mcp.json .claude/ .githooks/ .gitignore docs/ ':!.claude/project-profile.json'` — if those paths have
   uncommitted changes, stop and ask the user first. Skip this check when the folder is not a git work tree or has no commits.
2. Dry run, show the result:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js" --dry-run
   ```
3. Apply:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/project-setup/profile.js"
   ```
   Exit 0 = applied. Exit 1 = the files were applied but a `claude plugin` command failed (the
   `FAILED` lines say which). Exit 2 = REFUSED, nothing was written.
4. Run the `--check` command above; it must print `project-setup --check: clean`.
   `TODO kit-ci` / `DRIFT kit-ci`: write one workflow in `.github/workflows/` that runs the repo's own test
   command and the gate tools on push and pull_request, using the stack's setup action; show it to the owner
   before committing; rerun --check.
5. Profile has `gate` and the repo has no baseline file yet (default `.gate-baseline.json`): run
   `node .githooks/pre-commit --init` once (exit 0 = written; 2 = a needed tool is missing, the
   output names its install line).
6. Report the `APPLIED` lines. Do not commit; the user decides (the baseline file and
   `.githooks/pre-commit` are meant to be committed).

## Schema v1 (all keys optional)

```json
{ "version": 1,
  "size": "S",
  "hosting": "local",
  "methodology": "superpowers",
  "plugins": [{"id": "x@market", "marketplace": "owner/repo"}],
  "mcpServers": { "name": {"command": "...", "args": [], "type": "stdio"} },
  "skills": ["relative/path/in/repo"],
  "instructions": ["relative/path.md"],
  "gate": {"tools": ["gitleaks", "ruff", "eslint", "pyright", "tsc"], "baseline": ".gate-baseline.json"} }
```

- `size` -> the cumulative kit (XS rules only; S + git, runtime/ ignore, handoff/tests/plan rules; M + gate
  required, docs/uat/README.md, docs/DEPLOY.md; L + CHANGELOG.md, docs/rollback.md, docs/definition-of-done.md;
  L + hosting github: a CI workflow, checked as kit-ci) and the kit block in `.claude/CLAUDE.md` between `<!-- bajzi:project-setup kit begin/end -->`.
- `hosting: local` -> `.githooks/pre-push` refuses GitHub remotes (fails closed: a missing or unreadable profile
  counts as local; it reads the COMMITTED profile at HEAD, so a hosting change takes effect only once the profile
  is committed). A fresh folder gets `git init` and `core.hooksPath .githooks`; an existing repo with another
  hooksPath or a foreign pre-push is REFUSED.
- `methodology` -> `.claude/METHODOLOGY` (`superpowers`, `gsd` or `none`).
- `plugins` -> `claude plugin marketplace add <marketplace>` when missing, then
  `claude plugin install <id> --scope project`.
- `mcpServers` -> merged into `.mcp.json`; entries not in the profile are never deleted. Use it
  for repos whose runner passes `--strict-mcp-config --mcp-config .mcp.json`; everything else
  gets its MCPs at user scope from `/bajzi:setup`.
- `skills` -> each directory is linked as `.claude/skills/<dirname>` (a junction on Windows).
- `instructions` -> an `@../<path>` import block in `.claude/CLAUDE.md`, between
  `<!-- bajzi:project-setup instructions begin/end -->` markers; text outside the block is kept.
- `gate` -> copies `bajzi/gate/pre-commit.js` to `.githooks/pre-commit`. REFUSED unless
  `git config core.hooksPath` is `.githooks`, and when a `.githooks/pre-commit` that is not the bajzi
  gate is already there (move it away first). `tools` (subset of the five) narrows what the gate
  runs; `baseline` defaults to `.gate-baseline.json`. Contract: `docs/gate.md` in the bajzi repo.

Optional `docs/review-policy.md` (never created here): accepted risks and trusted inputs for the reviewer; format in the bajzi spec §6.12. It may also hold `## Checks`, `## Path instructions` and `## Always read` sections (spec §6.12).
