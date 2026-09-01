---
name: handoff
description: Session-állapot mentése a runtime/HANDOFF.md-be + javasolt kezdő prompt generálása a /clear utáni folytatáshoz. Használd, ha a felhasználó lezárja a sessiont, átadót kér, kifogy a kontextusból, vagy azt mondja "handoff", "mentsük el hol tartunk", "jön a /clear".
---

# HANDOFF — session-átadó

Készíts MOST teljes session-átadót a `runtime/HANDOFF.md` fájlba (a mappát hozd létre, ha
nincs; a meglévő fájlt írd felül). Tömören, PONTOSAN ez a szerkezet:

```markdown
# HANDOFF — session-folytatás
Frissítve: <mai dátum, idő> · Feladat: <a session célja egy mondatban>
## Hol tartunk
## Kész
## KÖVETKEZŐ LÉPÉS (pontosan, ezzel kell kezdeni)
## Döntések / csapdák
## Érintett fájlok (path-ok)
## JAVASOLT KEZDŐ PROMPT
```

A `## Hol tartunk` … `## Érintett fájlok` rész legfeljebb ~40 sor legyen.

## A JAVASOLT KEZDŐ PROMPT szekció — kötelező szabályok

A `## JAVASOLT KEZDŐ PROMPT` szekcióban **pontosan egy hárombacktickes kódblokk** legyen, benne
egy kész, bemásolható prompt a következő sessionhöz. A plugin `SessionStart` hookja
(`hooks/handoff-load.sh`) **ebből a kódblokkból** olvassa ki a szöveget, és `/clear` után kiírja
a felhasználónak — tehát a formátum kötött, ne térj el tőle.

A prompt legyen önmagában is működő utasítás, és tartalmazza:
- mit folytatunk (egy mondat), és hogy a részletek a `runtime/HANDOFF.md`-ben vannak;
- **a felhasználó már meghozott döntéseit** azzal, hogy ezeket NE kérdezze újra;
- a konkrét következő lépéseket sorszámozva;
- a fontos csapdákat, ha egy rossz első lépés kárt okozhat;
- ha a munka sub-agenteket igényel, azt is.

Írd meg egyes szám második személyben, ahogy a felhasználó írná — ne „a felhasználó azt kéri,
hogy…", hanem közvetlenül: „Folytatjuk a…".

Ha kaptál argumentumot / extra megjegyzést a felhasználótól, építsd be a promptba.

## A fájl megírása után

Írd ki a chatbe **magát a javasolt promptot is**, kódblokkban, hogy a felhasználó rögtön lássa és
másolhassa. Ezen kívül egyetlen rövid mondat: hogy a HANDOFF kész, és most jöhet a `/clear`.

Semmi mást ne csinálj.

## Környezeti eltérések

- **Claude Code:** a plugin SessionStart hookja `/clear`, `/compact` és `resume` után
  automatikusan betölti a HANDOFF.md-t és kiírja a javasolt promptot. A beviteli mező
  automatikus előkitöltése nem támogatott — a prompt megjelenik másolható formában.
- **Cowork:** ha a hookok nincsenek engedélyezve, a HANDOFF.md ugyanúgy elkészül; új
  beszélgetés elején a felhasználó bemásolja a javasolt promptot, vagy megkéri Claude-ot,
  hogy olvassa be a `runtime/HANDOFF.md`-t.
