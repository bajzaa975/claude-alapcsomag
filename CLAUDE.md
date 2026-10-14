# CLAUDE.md — bajzi plugins

**Before changing anything in this repo, read `docs/bajzi-package-spec.md`.** It is the
authoritative technical and functional spec of the whole package: saver levels L0-L3, the
glm/worker/ccr shims, the bajzi hooks (status line, context guard, secret guard, injection
scanner, dispatch guard), setup/manifest/project-setup, and the optional external-orchestrator
integration. Start from its §2 Change map (what → file → tests → review tier); do not explore
the repo first.

- Every change to the package updates `docs/bajzi-package-spec.md` in the SAME commit.
- Every plugin/skill/MCP add or removal updates `bajzi/skills/setup/manifest.json` in the same commit.
- Run `git fetch` before judging branch state — local `main` goes stale silently.

## Public repository — what may be committed

This repo is public. Commit only current text and code that describe or implement the plugins.
Never commit: private project names, machine details (absolute paths, hostnames, ssh aliases),
personal data, the maintainer's requests or decision history, bug lists, review results, executed
plans, status logs, or line/SHA pins. Plans, reviews and decision logs go to the gitignored
`runtime/` folder. Project-specific integrations ship as separate add-on plugins outside this repo.
