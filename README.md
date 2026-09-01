# bajzi-plugins — saját Claude Code / Cowork marketplace

Egyetlen plugin (`bajzi`), ami mindkét környezetben ugyanazt a munkamódszert adja:

| Komponens | Mit ad | Claude Code | Cowork |
|---|---|---|---|
| `alapcsomag` skill | token-takarékos projekt-réteg (MCP, hook, HANDOFF-váz) | ✅ | ✅ (MCP-rész kihagyva) |
| `autopilot` skill | felügyelet nélküli munkamenet döntésnaplóval | ✅ | ✅ |
| `handoff` skill | `runtime/HANDOFF.md` + javasolt kezdő prompt | ✅ | ✅ |
| SessionStart hook | `/clear` után visszatölti a HANDOFF-ot | ✅ | hooks engedélyezésétől függ |
| `shared/CLAUDE.md` | globális token-budget szabályok | kézzel `~/.claude/CLAUDE.md`-be | `shared/cowork-preferences.md` a Customize-ba |

A skillek hívása: `/bajzi:alapcsomag`, `/bajzi:autopilot`, `/bajzi:handoff` — vagy egyszerűen
kérd szövegesen („csinálj handoffot"), a leírás alapján maguktól is elindulnak.

## Telepítés — Claude Code (laptop)

```bash
claude plugin marketplace add <github-user>/claude-alapcsomag   # vagy: helyi útvonal
claude plugin install bajzi@bajzi-plugins
```

Majd a globális szabályok:

```bash
cat shared/CLAUDE.md >> ~/.claude/CLAUDE.md
```

Ellenőrzés: `claude plugin list`, új sessionben `/bajzi:handoff`.

### Marketplace nélkül, helyben (fejlesztéshez)

A `bajzi/` mappa bemásolható ide: `~/.claude/skills/bajzi/` — a következő session
automatikusan betölti `bajzi@skills-dir` néven.

## Telepítés — Cowork (Claude Desktop)

1. **Customize → Plugins → Add marketplace** → a repó URL-je
   (`https://github.com/<user>/claude-alapcsomag` vagy `<user>/claude-alapcsomag`).
2. A listából telepítsd a `bajzi` plugint.
3. **Vagy** repó nélkül: **Plugins → upload** és válaszd a `bajzi-plugin.zip`-et.
4. A `shared/cowork-preferences.md` tartalmát másold a személyes utasítások közé.

## Frissítés

Push a repóba → Claude Code: `claude plugin update bajzi` · Cowork: a marketplace-nél
**Update**, majd a plugin frissítése.
