---
name: fixture-model-versioned
description: Fixture whose model is a versioned id instead of an alias.
model: claude-opus-5-5
tools: Read, Edit, Grep, Glob, Bash
---
# Input
A slice spec.
# Output
DONE or BLOCKED.
# Rules
- Stay inside the slice's files.
# Never
- Never dispatch another agent.
