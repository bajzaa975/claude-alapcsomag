---
name: autopilot
description: Autonóm munkamenet — több feladat vagy sprint végigvitele kérdés nélkül, döntésnaplóval és zárójelentéssel. Használd, ha a felhasználó azt mondja "autopilot", "nem vagyok a gépnél", "csináld végig kérdés nélkül", "dolgozz önállóan a listán".
---

# AUTOPILOT MÓD

AUTOPILOT MÓD BE. A hatókör és az extra utasítások az argumentumban érkeznek (pl.
„SPRINT-12..15" vagy „a lista következő 3 tétele"). Ha nincs hatókör megadva, kérdezd meg
egyetlen mondatban — utána többet nem kérdezel.

A felhasználó nincs a gépnél; mostantól felügyelet nélkül dolgozol. Szabályok:

1. **NE kérdezz, ne várj jóváhagyásra.** Minden felmerülő kérdést magad döntesz el a projekt
   dokumentációja, a kód konvenciói és a józan ész alapján — a legkevésbé kockázatos, később
   legkönnyebben visszafordítható opciót választva.
2. **DÖNTÉSNAPLÓ:** minden érdemi (nem-triviális) döntést AZONNAL jegyezz be a
   `runtime/DECISIONS.md`-be, ebben a formában:

   ```markdown
   ## [dátum idő] <döntés címe>
   - Döntés: <mit döntöttél>
   - Alternatívák: <mi volt még szóba jöhető>
   - Miért: <indoklás 1-2 mondatban>
   - Kockázat: alacsony / közepes / magas
   - Érintett: <fájlok / sprint / modul>
   ```

3. **TILTOTT ZÓNA — autopilotban SEM döntheted el:** deploy/release/publish, force-push,
   git-history átírás, branch/fájl végleges törlése, secretek/credentialök bármilyen kezelése,
   CI-config (.github/) módosítása, DB-migráció éles adaton, függőség MAJOR-verzióváltása,
   a feladat eredeti céljának/scope-jának megváltoztatása. Ha ilyenbe futsz bele: jegyezd fel a
   DECISIONS.md-be **BLOKKOLVA** jelöléssel, és folytasd a következő feladattal.
4. **ELAKADÁS-SZABÁLY:** egy hibára legfeljebb 3 javítási kísérlet; utána a tétel **PARKOLVA**
   (állapot + amit kipróbáltál a DECISIONS.md-be), és mész tovább. Parkolt tétel miatt nem áll
   meg az egész futás.
5. **KONTEXTUS-FEGYELEM:** feladatonként/sprintenként sub-agentek végzik a nehéz munkát; a
   HANDOFF.md-t minden lezárt tétel után frissíted. Ha a kontextus ~40% fölé ér: NEM kezdesz új
   tételbe — lezárod az aktuálisat, megírod a zárójelentést, és szabályozottan leállsz (a
   maradék tételeket „NEM KEZDTEM EL" listába írod).
6. **ZÁRÓJELENTÉS:** a futás végén írd meg a `runtime/AUTOPILOT-REPORT.md`-t: elvégzett tételek
   (teszt-státusszal), helyetted hozott döntések összefoglalója (DECISIONS.md-re hivatkozva),
   PARKOLT és BLOKKOLT tételek, és egy „EZT NÉZZÜK ÁT EGYÜTT" lista prioritás-sorrendben.
   A chatben ugyanennek a tömör kivonatát add.

**Kikapcsolás:** ha a felhasználó bármikor azt írja: „autopilot ki" — azonnal visszaállsz normál
(kérdezős) módba, és röviden összefoglalod, hol tartasz.
