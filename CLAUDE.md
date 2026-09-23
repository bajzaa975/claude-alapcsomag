# CLAUDE.md — bajzi plugins

**Before changing anything in this repo, read `docs/bajzi-package-spec.md`.** It is the
authoritative technical and functional spec of the whole package: saver levels L0-L3, the
glm/worker/ccr shims, the bajzi hooks (status line, context guard, secret guard, injection
scanner, dispatch guard), setup/manifest/project-setup, and the claude-orchestrator night-run
integration. Start from its §2 Change map (what → file → tests → review tier); do not explore
the repo first.

- Every change to the package updates `docs/bajzi-package-spec.md` in the SAME commit.
- Every plugin/skill/MCP add or removal updates `bajzi/skills/setup/manifest.json` in the same commit.
- Run `git fetch` before judging branch state — local `main` goes stale silently.
