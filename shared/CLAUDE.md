## Token-budget (KEMÉNY szabályok — minden projektre)
1. **50% plafon:** egy session SOHA ne menjen a kontextusablak 50%-a fölé. 40% felett nincs új
   scope. Mérés: `/context`.
2. **Sub-agentek KÖTELEZŐK:** repo-feltárás, több-fájlos olvasás, teszt-/lint-futtatás
   sub-agentbe (Agent/Task tool); a fő szálba csak tömör eredmény kerül, soha nyers kimenet.
3. **~300 sornál hosszabb fájl nem megy a fő szálba** — sub-agent, vagy `rtk read -l aggressive`.
4. **Path-hivatkozás beillesztés helyett;** a projekt CLAUDE.md ≤ 200 sor, a részletek
   docs-fájlokban.
5. **Egy feladat = egy fókuszált session;** a session a feladat végén kilép (`/exit`).

## Kontextus-őr + HANDOFF (minden projektre)
- Minden lezárt részfeladat után frissítsd a `runtime/HANDOFF.md`-t (≤40 sor: hol tartunk, mi
  kész, PONTOS következő lépés, döntések/csapdák, érintett fájl-pathok). Ha a mappa nincs meg,
  hozd létre. Erre való a `/bajzi:handoff` skill.
- Ha a kontextus eléri a ~40%-ot (`/context`, vagy a CLI "context low" jelzése), NE kezdj új
  alfeladatba: az aktuálisat fejezd be, véglegesítsd a HANDOFF.md-t, majd írd ki a
  felhasználónak: **„Kontextus 40% felett — futtass /clear-t; a folytatáshoz szükséges állapot a
  runtime/HANDOFF.md-ből automatikusan betöltődik."**
- `/clear` vagy compact után a `bajzi` plugin SessionStart-hookja betölti a HANDOFF.md-t → onnan
  folytass, NE olvasd újra az egész repót.

## RTK — parancskimenet-tömörítés (CSAK ha telepítve van)
- `rtk pytest` · `rtk ruff check` · `rtk err npm run build` · `rtk git status|log|diff` ·
  `rtk read <f>` · `rtk grep "p" .` · `rtk ls .` · `rtk find "*.py" .` · `rtk test <parancs>`
- SOHA ne menjen rtk-n: deploy/release, ssh/scp, titok-kezelés, DB-migráció, állapot-változtató
  git. Ha nincs rtk, minden nyersen fut — az RTK soha nem feltétel.
- `sudo` alatt mindig teljes elérési út kell (`/usr/bin/git`), különben „rtk: command not found".

## MCP-higiénia
- Batch/automatizált futásnál: `claude --strict-mcp-config --mcp-config .mcp.json`.
- Review: code-review-graph (graph build → review-kontextus, csak blast-radius fájlok).
- Szimbólum-navigáció (token-savior): `find_symbol`/`get_function_source` teljes fájl helyett.
