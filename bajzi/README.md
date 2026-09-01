# bajzi

Token-takarékos munkamódszer Claude Code-hoz és Coworkhöz.

## Skillek

| Parancs | Mit csinál | Mikor |
|---|---|---|
| `/bajzi:handoff` | `runtime/HANDOFF.md` + bemásolható kezdő prompt | `/clear` előtt, 40% kontextusnál |
| `/bajzi:alapcsomag` | projekt-réteg: `.mcp.json`, kontextus-őr, HANDOFF-váz | új repóban egyszer |
| `/bajzi:modszertan` | GSD vs superpowers vs none → `.claude/METHODOLOGY` | repónként egyszer |
| `/bajzi:autopilot` | felügyelet nélküli munkamenet döntésnaplóval | ha elmész a gép mellől |
| `/bajzi:setup` | teljes gép-beállítás a `skills/setup/manifest.json` szerint | új gépen |

## Hookok (SessionStart, függőségmentes shell)

- `handoff-load.sh` — `/clear`, `/compact`, `resume` után visszatölti a HANDOFF-ot
- `methodology-guard.sh` — repónként rögzíti, melyik módszertan vezet, és ezt a kontextusba teszi

## Új eszköz felvétele

Egyetlen fájl: `skills/setup/manifest.json`. Push → minden gép megkapja a következő
`/bajzi:setup`-nál.

Telepítés és a globális szabályok: a repó gyökerében lévő `README.md`.
