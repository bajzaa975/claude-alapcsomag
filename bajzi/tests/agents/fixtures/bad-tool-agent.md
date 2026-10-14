---
name: fixture-tool-agent
description: Fixture that tries to give itself the Agent tool, i.e. dispatch another agent.
model: sonnet
tools: Read, Agent
---
# Input
A slice spec.
# Output
DONE or BLOCKED.
# Rules
- Stay inside the slice's files.
# Never
- Never dispatch another agent.
