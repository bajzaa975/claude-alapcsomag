---
name: handoff
description: Save session state into runtime/HANDOFF.md + generate a suggested opening prompt for continuing after /clear. Use it when the user closes the session, asks for a handoff, is running out of context, or says "handoff", "let's save where we are", "/clear is coming".
---

# HANDOFF — session handover

Write a full session handover NOW into the `runtime/HANDOFF.md` file (create the directory if it
does not exist; overwrite the existing file). Terse, EXACTLY this structure:

```markdown
# HANDOFF — session continuation
Updated: <today's date, time> · Task: <the session's goal in one sentence>
## Where we are
## Done
## NEXT STEP (exactly, start with this)
## Decisions / pitfalls
## Affected files (paths)
## SUGGESTED OPENING PROMPT
```

The `## Where we are` … `## Affected files` part must be at most ~40 lines.

## The SUGGESTED OPENING PROMPT section — mandatory rules

The `## SUGGESTED OPENING PROMPT` section must contain **exactly one triple-backtick code block**,
holding a ready, pasteable prompt for the next session. The plugin's `SessionStart` hook
(`hooks/handoff-load.sh`) reads the text **out of this code block** and prints it to the user after
`/clear` — so the format is fixed, do not deviate from it.

The prompt must work as a standalone instruction, and must contain:
- what we are continuing (one sentence), and that the details are in `runtime/HANDOFF.md`;
- **the decisions the user has already made**, with the note NOT to ask about them again;
- the concrete next steps, numbered;
- the important pitfalls, if a wrong first step could cause damage;
- if the work requires sub-agents, that too.

Write it in the second person, the way the user would write it — not "the user asks that…",
but directly: "We are continuing the…".

If you received an argument / extra note from the user, build it into the prompt.

## After writing the file

Also print **the suggested prompt itself** into the chat, in a code block, so the user sees it right
away and can copy it. Beyond that, a single short sentence: that the HANDOFF is done and `/clear`
can come now.

Do nothing else.

## Environment differences

- **Claude Code:** the plugin's SessionStart hook automatically loads HANDOFF.md after `/clear`,
  `/compact` and `resume`, and prints the suggested prompt. Automatically prefilling the input
  field is not supported — the prompt appears in copyable form.
- **Cowork:** if hooks are not enabled, HANDOFF.md is still produced; at the start of a new
  conversation the user pastes the suggested prompt, or asks Claude to read
  `runtime/HANDOFF.md`.
