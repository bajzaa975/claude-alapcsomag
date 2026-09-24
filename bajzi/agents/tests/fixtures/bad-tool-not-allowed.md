---
name: fixture-tool-not-allowed
description: Fixture that lists a tool outside the allow-list.
model: sonnet
tools: Read, WebFetch
---
# Input
A slice spec.
# Output
DONE or BLOCKED.
# Rules
- Stay inside the slice's files.
# Never
- Never dispatch another agent.
