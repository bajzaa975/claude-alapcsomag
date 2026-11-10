# Methodology guide

How a project goes from idea to close with the bajzi plugin: which size it is, which methodology
leads, which command to run at each step. Every `/bajzi:*` command named here is a skill in
`bajzi/skills/`. Not sure which one you need: `/bajzi:which <what you want>`.

## In five lines

1. Work starts with planning, not code: idea -> questions -> spec -> plan.
2. Claude writes code in small slices, each with a test.
3. A different model reviews every slice, two rounds at most.
4. "Done" means: the gate (automatic check) is green, the review is clean, and you tried it (UAT).
5. A person approves every push, deploy and secret.

## 1. Project size: XS / S / M / L

Every project has a size in `.claude/project-profile.json` (`size`). The size decides how much
mandatory safety net it gets. The kits are cumulative: each size adds to the one below.

| Size | When | Kit |
|---|---|---|
| XS | small asks and questions, no product of its own | the general repo (section 3): one `notes/<topic>/` folder per topic; no plan, no review unless the change touches a real system (server, device, shared config) |
| S | one person, one machine, nothing deployed (the default when no answer points higher) | local git, handoff, tests for every behaviour change, one written plan per feature |
| M | deployed somewhere, used by anyone else, or holds personal data or money | S + the bajzi pre-commit gate, one Opus review per sprint, `docs/uat/<release>.md`, `docs/DEPLOY.md` |
| L | production users with a release cycle, more than one developer, or more than one service or repo | M + CI, `CHANGELOG.md` release notes, `docs/rollback.md`, a `/bajzi:respec-cards` spec before the plan, `docs/definition-of-done.md` |

### How the size is decided

`/bajzi:project-setup` runs a start assessment when the profile has no `size` or no `hosting`.
It asks one round of five questions, each with a recommended answer taken from the folder:

1. A general repo for mixed small asks (no single product)? Yes -> XS.
2. Deployed anywhere, used by anyone else, or personal data or money? Yes -> at least M.
3. Production users with a release cycle? Yes -> L.
4. More than one developer, or more than one service or repo? Yes -> L.
5. May the code and its data be uploaded to GitHub? (section 2)

Size is the highest size any answer gives; no answer -> S. It then writes `size`, `hosting` (and a
`gate` for M/L) into the profile, shows the diff and applies the kit. The kit only adds files.

### Growing a project

Before every new plan, check the triggers in the project's `.claude/CLAUDE.md` kit block:

- XS -> S: a topic spans more than 2 sessions, produces lasting code or scripts, needs tests, or outgrows one note.
- -> M: a deploy target, another user, or personal data or money.
- -> L: production users with a release cycle, more than one developer, or more than one service or repo.

Claude proposes the change in one line, and edits `size` only after your OK. Then run
`/bajzi:project-setup`. The size never shrinks by itself, and a downgrade deletes nothing.

### Done, by size

| Size | Done when |
|---|---|
| XS | the question is answered, or the change is checked on the real system |
| S | tests green, the plan's items done, handoff updated |
| M | S + gate green + review CLEAN + UAT checklist passed |
| L | M + CI green + release notes + rollback plan |

## 2. GitHub or local: decided by data sensitivity

Hosting is independent of size: a tiny project can be `local`, a large one `github`.

- `hosting: local` (never pushed) when the code or its data includes any of: personal data of
  other people, confidential client or employer material, credentials, financial or regulated data.
  When unsure, choose `local`.
- Otherwise `hosting: github`, in a PRIVATE repo by default. Public only when it is meant to be public.
- Small one-off asks live in ONE general repo (section 3), not in a new repo each.

Local git exists in every case. With `local`, `/bajzi:project-setup` installs `.githooks/pre-push`,
which refuses any push to a GitHub remote, at every size. The hook reads the committed profile, so
a hosting change counts once the profile is committed. Moving a project from `local` to `github`
is a deliberate edit of `hosting` plus a commit, never a side effect.

## 3. The general repo (XS)

- One local-only repo, size XS, for mixed small asks and questions.
- One `notes/<topic>/` folder per conversation. No secrets in it, keyring references only.
- Claude suggests turning a topic into a small project when it passes the XS -> S triggers above.
  Then create the project and copy the note in as starting context.

## 4. Choosing a methodology

GSD and superpowers cover the same ground (plan, execute, review, debug, verify), so the choice is
made once per repo and stored in `.claude/METHODOLOGY`. Run `/bajzi:modszertan` to set it.

| This repo | Choose |
|---|---|
| long work in phases; needs a roadmap, a `.planning/` trail, UAT | `gsd` |
| daily development, bugfixes, features; TDD, systematic debugging, sub-agents | `superpowers` (the default if unsure) |
| small repo, config, script, docs; ceremony is an obstacle | `none` |

A SessionStart hook reads the file and tells Claude which skill family to follow. The setting takes
effect from the next session.

## 5. The lifecycle

| Step | What happens | Command or skill |
|---|---|---|
| Idea | You write 3-5 sentences: what you want and for whom. No code yet. | |
| Refine | Claude asks, one question at a time; you answer, or say you do not know. | `superpowers:brainstorming` (always the base); `/bajzi:grill-me` to stress-test a feature plan; `/bajzi:respec-cards` for a new or large system (L). A project-sized design is grilled automatically (`bajzi:grilling`) before approval, see `docs/design-grilling.md` |
| Spec | The goal, non-goals and decisions in a design doc. You read it and correct it. | `superpowers:brainstorming` writes it |
| Plan | A step-by-step plan; no open question may remain before execution. | `superpowers:writing-plans` |
| Critic (M/L) | A read-only agent lists the plan's likely failure scenarios; you accept or reject each before execution starts. | `/bajzi:critic <plan-stem>`; the whole process is in `docs/dev-process.md` |
| Implement | One slice at a time, test first. | `/bajzi:implement <slice-id>`, or `superpowers:subagent-driven-development` |
| Review | Risk decides depth (below). Result in `runtime/findings/<id>-r1.md`. | `/bajzi:review <slice-id> <range>` |
| Fix | Fix, gate, commit, then the second review round, then stop. | `/bajzi:fix runtime/findings/<id>-r1.md` |
| Gate | The repo's test command (or the pre-commit gate) exits 0. Claude's words are not evidence; the exit code is. | |
| UAT | You try it, not Claude. M and up keep a list in `docs/uat/<release>.md`; run it once at the end of a release. | |
| Close | A person approves push and deploy. Claude names the commit SHA first. | `superpowers:finishing-a-development-branch` |

Slices (`runtime/slices/<id>.md`) are generated from the approved plan; you do not write them by hand.

### Review depth

Depth follows the slice's risk, not who wrote it.

| Tier | For | Reviewer |
|---|---|---|
| 1 | auth, quotas, locks, secrets, destructive or outward-facing actions, migrations, money | Opus, fresh context, full round |
| 2 | UI, wiring, mechanical change, a tightly scoped fix | a cheaper model flags file:line; Opus judges only those |
| 3 | docs, comments, decision log | the gate only |

Rules: the weaker model never gives final approval on the stronger one's work. Two rounds at most;
what is still serious after round 2 goes to the owner. CLEAN = nothing open but test gaps (no
blocker, major, minor or nit) and a green gate. Machine checks (tests, grep) come before model opinion.

## 6. Execution modes

| Mode | When | How |
|---|---|---|
| Day run | you are at the machine | ask for the plan to be carried out; Claude uses `/bajzi:implement` or sub-agents and may ask you |
| Autopilot | daytime, you are away | `/bajzi:autopilot <tasks>`, or `/bajzi:mode day-run`; no questions, a decision log and a closing report remain |
| Night run | several hours, unattended | `/bajzi:night-run project:<name> hours:<n>`; Claude preflights, shows the queue and starts only after your "go" |

All three start from an approved plan. A plan that is not approved, or still has an open question,
does not run. A night run never pushes; an item that needs a new decision is parked and the run
continues.

## 7. Handoff and context

Around 40% context: `/bajzi:handoff`, then `/clear`. The handoff is saved per branch in
`runtime/handoff/<branch-slug>.md` and loaded automatically in the new session. Never go above 50%
in one session. `/bajzi:debt --check` shows the small deferred findings; too many blocks new slices.

## 8. If you get stuck

- Do not know which command: `/bajzi:which <what you want>`.
- A review keeps finding the same thing: after two rounds it is the owner's call (fix, accept or park).
- The gate is red: read the exit code and the first error; never bypass it with `--no-verify`.
- The session got long or confused: `/bajzi:handoff`, `/clear`, continue from the handoff.
- Unsure about the machine setup: `/bajzi:setup --check`; about the project kit: `/bajzi:project-setup --check`.
