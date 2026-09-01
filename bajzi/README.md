# bajzi

Token-takarékos munkamódszer Claude Code-hoz és Coworkhöz.

- `/bajzi:alapcsomag` — projekt-réteg telepítése (MCP, kontextus-őr hook, HANDOFF-váz)
- `/bajzi:autopilot` — felügyelet nélküli munkamenet döntésnaplóval és zárójelentéssel
- `/bajzi:handoff` — `runtime/HANDOFF.md` + bemásolható javasolt kezdő prompt
- SessionStart hook — `/clear`, `/compact`, `resume` után visszatölti a HANDOFF-ot
  (függőségmentes shell script: nem kell jq/python/node)

Telepítés és a globális szabályok: lásd a repó gyökerében lévő `README.md`-t.
