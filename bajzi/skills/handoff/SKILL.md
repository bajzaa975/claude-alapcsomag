---
name: handoff
description: Save session state into runtime/handoff/<task>.md + generate a suggested opening prompt for continuing after /clear. Use it when the user closes the session, asks for a handoff, is running out of context, or says "handoff", "let's save where we are", "/clear is coming".
---

# HANDOFF — session handover

Write a full session handover NOW. One file PER TASK, not per project — several sessions run at
once and a single shared file means whoever closes out last silently destroys the others.

## Where the file goes

`runtime/handoff/<slug>.md` (create the directory if it does not exist).

`<slug>` is the sanitized current branch name. Derive it with EXACTLY this command — the
SessionStart hook (`hooks/handoff-load.sh`) derives it the same way, and if the two drift you will
write files the hook can never find:

```bash
b=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || printf '')
if [ -z "$b" ]; then slug=default; else
  slug=$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9._-]/-/g' -e 's/--*/-/g' -e 's/^-*//' -e 's/-*$//' \
    | cut -c1-60 | sed -e 's/-*$//')
  [ -z "$slug" ] && slug=default
fi
echo "$slug"
```

Not a repo, detached HEAD, git missing, or the "dubious ownership" error on a root-owned repo —
all of them give `default`. That is correct, do not try to work around it with sudo.

**Migration:** if `runtime/HANDOFF.md` (the old single-file path) exists, MOVE it to
`runtime/handoff/<slug>.md` as part of this write — `git mv` if it is tracked, otherwise `mv`.
The hook still reads the old path, so nothing breaks if you skip it, but do not leave both.

**Gitignore:** handovers are session scratch and must never be committed. If `runtime/` is not
already ignored, append `runtime/` to `.gitignore` before writing.

## Do not overwrite a live peer

Before writing, if the target file already exists, read its `Owner-session:` line.

- Same session as yours → overwrite, no question.
- **Different** session AND the file is **under 2 hours old** → STOP. Another session is
  working this same task right now. Show the user its `Owner-session` and `Updated` values and
  ask whether to overwrite, merge, or write elsewhere. Do not decide this alone.
- Different session but older than 2 hours → overwrite, and say so in your closing report.

## Structure

Terse, EXACTLY this structure:

```markdown
# HANDOFF — session continuation
Updated: <today's date, time> · Task: <the session's goal in one sentence>
Owner-session: <this session's name and ref, e.g. ubuntu-96 [b69cb7]>
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
- what we are continuing (one sentence), and that the details are in `runtime/handoff/<slug>.md`;
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

If `runtime/handoff/` holds files older than 30 days, mention them in one line so the user can
clear them out. Do NOT delete anything yourself.

Do nothing else.

## Environment differences

- **Claude Code:** the plugin's SessionStart hook automatically loads the handover for the current
  task after `/clear`, `/compact` and `resume`, and prints the suggested prompt. Automatically
  prefilling the input field is not supported — the prompt appears in copyable form.
  If no handover exists for the current task but others do, the hook lists them and loads NOTHING
  — that is deliberate, so you never resume the wrong task.
- **Cowork:** if hooks are not enabled, the file is still produced; at the start of a new
  conversation the user pastes the suggested prompt, or asks Claude to read
  `runtime/handoff/<slug>.md`.
