---
name: fixture-good
description: Fixture used only by agents.test.js to prove the validator accepts a conforming file.
model: sonnet
tools: Read, Edit, Grep, Glob, Bash
---
# Input
A slice spec: id, files it may touch, acceptance criteria, test command.
# Output
`SLICE <id> DONE` or `SLICE <id> BLOCKED: <one line>`.
# Rules
- Touch only the files listed in the spec.
- Run the test command before reporting DONE.
# Never
- Never dispatch another agent.
- Never commit, push, stash, rebase or change branches.
