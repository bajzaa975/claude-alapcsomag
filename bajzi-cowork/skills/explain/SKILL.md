---
name: explain
description: Re-explains the last answer, or a named point of it, simply and in the user's language.
disable-model-invocation: true
argument-hint: ["<what I did not understand>"] | --set-language <code>
---

## Set the language

If the arguments are `--set-language <code>`: run `node <skill dir>/lang.js set <code>` (`<skill dir>` = the folder of this SKILL.md), show its one-line result or its error, and stop. Nothing else.

## Re-explain

1. Language: run `node <skill dir>/lang.js get`. Non-empty output = that language code. Empty = the language of the user's request text. This overrides any "answer in English" default for this one reply only.
2. Find the named point in this session's recent answers. No argument = the last answer.
3. Re-explain it:
   - Short sentences, everyday words.
   - Each unavoidable technical term gets one sentence of explanation.
   - An everyday comparison only if it really helps.
   - At most about 150 words.
   - Last line, separate: what the session needs from the user, or that nothing is needed.
4. Tired mode on in this session: even simpler and shorter.
5. One-shot: the next answers return to normal.
