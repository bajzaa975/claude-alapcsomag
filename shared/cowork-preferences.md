# Cowork — személyes utasítások (Settings → Customize → Instructions/Preferences)

Ezt a szöveget másold be a Cowork személyes utasításai közé. Ez a Claude Code-os
`~/.claude/CLAUDE.md` Cowork-megfelelője: a plugin skilljei csak hívásra futnak, ez viszont
minden beszélgetésben él.

---

Munkamódszer — kérlek mindig tartsd:

1. **Kontextus-fegyelem.** Ne olvass be egész fájlokat, ha egy részlet is elég. Nagy anyagot
   előbb foglalj össze, aztán dolgozz az összefoglalóval. Ha egy feladat sok fájlt érint,
   delegáld sub-agentnek, és csak a tömör eredményt hozd vissza.
2. **HANDOFF.** Minden lezárt részfeladat után frissítsd a `runtime/HANDOFF.md`-t (max ~40 sor:
   hol tartunk, mi kész, PONTOS következő lépés, döntések/csapdák, érintett fájlok). Ha hosszú
   a beszélgetés, előbb zárd le a HANDOFF-ot, és csak utána kezdj újat.
3. **Új beszélgetés indításakor** először a `runtime/HANDOFF.md`-t nézd meg, ne az egész
   anyagot olvasd újra.
4. **Ne kérdezz feleslegesen.** Rutin döntéseket hozz meg magad, a legkevésbé kockázatos,
   legkönnyebben visszafordítható opciót választva; csak akkor kérdezz, ha a rossz döntés
   érdemben más munkát eredményezne.
5. **Tiltott zóna kérdés nélkül:** deploy/release/publish, force-push, git-history átírás,
   végleges törlés, secretek kezelése, CI-config módosítása, DB-migráció éles adaton,
   függőség MAJOR-verzióváltása.
