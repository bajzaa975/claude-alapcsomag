---
name: which
description: Answers which installed skill or slash command fits what the owner wants to do, with the exact command to type and where it is installed. Use it on "/bajzi:which <intent>", "which skill", "which command should I use", "what was the command for", "what is the command", "which skill do I need".
argument-hint: <what you want to do>
---

# /bajzi:which <intent>

Answer "which skill or command, exact syntax, where installed" for the owner's intent. Rules, in order:

1. No intent given -> ask for it in one line; nothing else.
2. Candidates come from TWO sources, never anywhere else:
   a. the skills and commands available in THIS session (the available-skills list you already have, plus
      built-in slash commands such as /security-review, /context, /clear, /mcp);
   b. `~/.claude/skill-catalog.json` if it exists (written by an external orchestrator; schema:
      `{generated_at, machines[], skills[{name, invoke, lane, when, source, machine, scope, model_invocable,
      uses_30d, last_used}]}`). Read it with the Read tool. If missing or unparseable, say "catalog not found,
      answering from this session only" in one line and continue with (a). Never write or regenerate it.
3. Answer with at most 3 matches, best first, each as:
   `<exact command to type>` — <one line why it fits> — <where: "here" | machine + scope from the catalog>
   — <"runs on its own if you just describe the task" when model-invocable, else "type it">.
   If the best match is installed only elsewhere (another project or another machine per the catalog), say where
   and how to reach it (cd into that project / connect to that machine).
4. Never invent a skill or command name or flags: every command shown must appear in source (a) or (b),
   with the syntax taken from its description/argument-hint. Unsure about arguments -> show the bare command.
5. Nothing fits -> say "no installed skill fits" and, in one line, what the owner could do instead
   (describe the task in plain words). Do not suggest installing anything.
6. Read-only: no tool use beyond reading the catalog; no Bash, no edits, no sub-agents. English output
   (the global rule), terse.
