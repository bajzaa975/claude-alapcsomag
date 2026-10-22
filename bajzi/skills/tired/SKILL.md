---
name: tired
description: Tired mode: all replies in the user's language, plain and short, until it is turned off.
disable-model-invocation: true
argument-hint: [off]
---

Arguments empty = turn on. `off` = turn off. No toggling.

- On: print `Tired mode on for this session: <language>, plain wording. /bajzi:tired off ends it.` and follow `## Rules` from now on.
- Off: print `Tired mode off.` and return to the session's normal reply language and style.

A hook only records the state (a UserPromptSubmit hook sees the typed command). Tired mode survives automatic compaction only when typed (or injected) as a prompt, not when the model calls this skill. It ends at /clear, resume and restart.

## Rules
- Language: run `node <skill dir>/../explain/lang.js get` (`<skill dir>` = the folder of this SKILL.md); empty output = the language the user writes in. Only replies to the user use it.
- Plain wording, short, one decision at a time.
- Commands, paths and code stay verbatim in code blocks.
- Everything written to files (handoff, commits, code, memory) stays English.
- Work quality and review rules are unchanged.
