---
name: modszertan
description: A repó vezető fejlesztési módszertanának kiválasztása vagy megváltoztatása (GSD vs superpowers vs egyik sem). Használd, ha a felhasználó azt mondja "módszertan", "melyiket használjuk", "váltsunk GSD-re", "ne csináld a .planning-et", vagy ha a SessionStart hook jelezte, hogy nincs még döntés ebben a repóban.
---

# Vezető módszertan beállítása erre a repóra

A GSD és a superpowers ugyanazt a területet fedi — terv, végrehajtás, code review,
debug, verifikáció. Ha mindkettő telepítve van, ugyanarra a feladatra hol az egyiket,
hol a másikat választanám. Ez a döntés **repónként** születik, és a
`<repo>/.claude/METHODOLOGY` fájlban él.

## Teendő

1. Nézd meg, van-e már `.claude/METHODOLOGY`, és mi van benne.
2. Ha a felhasználó megmondta az argumentumban, mit akar, azt írd be. Ha nem, **kérdezd
   meg egyszer**, röviden — a lenti táblázattal segítve a választást.
3. Írd a választ egyetlen szóként a `<repo>/.claude/METHODOLOGY` fájlba:
   `gsd` · `superpowers` · `none`
4. Egy mondatban erősítsd meg, és jelezd, hogy a következő session-indítástól él.

## Döntési segédlet

| Ez a repó… | Válaszd |
|---|---|
| hosszú, több fázisra bontott munka; kell roadmap, phase-ek, `.planning/` nyomvonal, UAT | **gsd** |
| napi fejlesztés, bugfix, feature-ök; kell TDD-fegyelem, szisztematikus debug, sub-agent minták, worktree-izoláció | **superpowers** |
| kicsi repó, konfig, script, dokumentáció; a ceremónia csak akadály | **none** |

Ha bizonytalan a felhasználó: **superpowers** a jó alapértelmezés — kevesebb szertartás,
és bármikor átváltható. A GSD-t akkor érdemes bekapcsolni, ha tényleg kell a fázis-nyomvonal.

## Amit a beállítás után csinál a rendszer

A plugin SessionStart hookja (`methodology-guard.sh`) minden session elején beolvassa a
fájlt, és a kontextusba teszi, hogy melyik skill-családot használd és melyiket kerüld.
A superpowers nem-ütköző skilljei (`using-git-worktrees`, `dispatching-parallel-agents`,
`test-driven-development`) GSD-módban is használhatók.

A `.claude/METHODOLOGY` verziózható — ha a csapat többi tagja is Claude Code-ot használ,
commitold; ha csak neked kell, tedd a `.gitignore`-ba.
