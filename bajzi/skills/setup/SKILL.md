---
name: setup
description: Claude Code gép beállítása a kívánt állapotra — bővítmény-takarítás, majd a manifest szerinti marketplace-ek, pluginok, GSD, rtk és settings telepítése. Használd ÚJ GÉPEN, vagy ha egy meglévő telepítést rendbe kell tenni ("állítsd be ezt a gépet", "takarítsd ki a pluginokat", "legyen olyan, mint a másik gépem").
---

# Gép-beállítás a manifest szerint

A kívánt állapot **a `manifest.json`-ban van, ebben a mappában**. Először OLVASD BE, és
mindent abból végy — ne ebből a leírásból, és ne a memóriádból. Ha a manifest és e fájl
között ellentmondás van, a manifest nyer.

Fázisonként dolgozz, minden fázis végén egy soros státusz. Windowson a `~/.claude` a
`C:\Users\<user>\.claude`.

## Tiltólista

A manifest `tiltolista_torlesnel` tömbjében felsorolt útvonalakhoz **soha ne nyúlj**, akkor
sem, ha a feladat „takarítás". Ezek törléssel nem jönnek vissza: kijelentkezés, session-
történet, memória. Ha bizonytalan vagy egy fájlnál: NE töröld, tedd a jelentésbe „kézire".

## A FÁZIS — Mentés (ezzel kezdd, kihagyni tilos)

```
tar -czf ~/claude-backup-$(date +%Y%m%d-%H%M).tgz -C ~ \
  --exclude='.claude/plugins/cache' --exclude='.claude/shell-snapshots' \
  --exclude='.claude/file-history' --exclude='.claude/paste-cache' .claude
```

Írd ki a mentés útvonalát és méretét. Natív Windowson, ha nincs `tar`: másold a mappát
`~/.claude-backup-<dátum>` néven, és ezt jelezd.

## B FÁZIS — Leltár, MIELŐTT bármit törölnél

Gyűjtsd össze és írd ki tömören: `claude plugin list`, `claude plugin marketplace list`,
a `~/.claude/{skills,commands,agents,hooks}` tartalma, a `settings.json`
hooks/statusLine/enabledPlugins/permissions/skillOverrides blokkjai, és hogy van-e GSD
(`~/.claude/.gsd-source`).

Minden elemnél jelöld: **KELL** (szerepel a manifestben) vagy **TÖRLENDŐ**. A manifest
`tudatosan_kihagyva` listáján lévőket külön jelöld — azok nem véletlenül hiányoznak.

## C FÁZIS — Takarítás

1. **Idegen pluginok:** `claude plugin uninstall <id>` minden pluginra, ami nincs a manifest
   `plugins` listáján. A `~/.claude/plugins/` alatt **kézzel soha ne törölj** — az
   `installed_plugins.json` inkonzisztenssé válna. Csak a CLI-t használd.
2. **Idegen marketplace-ek:** `claude plugin marketplace remove <név>`.
3. **Nem-plugin skillek/commandok/agentek:** a `~/.claude/{skills,commands,agents}` alatt
   minden törlendő, ami nem `gsd-*` és nem plugin telepítette. **Külön figyelj** az
   `alapcsomag`, `autopilot`, `handoff` nevekre és a `hooks/handoff-load.sh`-ra: ezeket a
   `bajzi` plugin váltja ki, duplikátumként mindkettő betöltődne. Törlés előtt sorold fel,
   mit fogsz törölni.
4. **settings.json:** vedd ki az árva hookokat (nem létező scriptre mutatnak), a
   `handoff-load.sh`-t hívó SessionStart bejegyzést (a plugin hozza), és a törölt pluginra
   mutató `skillOverrides` sorokat. A GSD hookjait és a statuslinet HAGYD BÉKÉN.
   Előtte mentés: `settings.json.bak-<dátum>`.
5. **Ismert maradványok:** a manifest `ismert_maradvanyok` listája alapján. Ezek nagy,
   elárvult adatkönyvtárak — a listában ott a bizonyíték is, melyik eszközé.
6. **GSD-t kézzel NE takarítsd** — a D fázisban a saját telepítője rendbe teszi magát.

## D FÁZIS — Telepítés

1. Ellenőrzés: `claude --version`, `node -v`, és hogy van-e `bash` a PATH-on. **Windowson
   Git for Windows nélkül nincs bash**, és a hookok némán nem futnak — ezt jelezd.
2. A manifest `marketplaces` listája: `claude plugin marketplace add <source>`.
3. A manifest `plugins` listája:
   - ami még nincs fent: `claude plugin install <id>`
   - **ami már fent van: `claude plugin update <név>`** — a setup nem csak telepít, hanem
     naprakészre is hoz. A frissítés a következő session-indításkor lép életbe.
   Minden tétel után `claude plugin details <név>` — a tokenköltséget írd be a jelentésbe.

   **SZÁNDÉKOSAN LETILTOTT PLUGINT SOHA NE KAPCSOLJ VISSZA.** Ha a `claude plugin list`
   szerint egy plugin `disabled`, hagyd úgy, és írd a jelentésbe, hogy letiltva maradt.
   A `claude plugin enable` parancsot ez a skill NEM használja. Ha a manifest tételénél van
   `windows` mező és ezen a platformon futsz, azt olvasd el és kövesd — ott van megírva,
   melyik plugin ismerten problémás és mi a teendő.
4. **GSD:** interaktív telepítő, **NE te indítsd**. Írd ki a felhasználónak a manifest
   `gsd.install` parancsát, és hogy a promptokban mit válasszon (`runtime`, `scope`,
   `profile`). Várd meg, míg szól, hogy kész.
5. **Globális szabályok:** a manifest `globalis_szabalyok` mezője szerint.
6. **settings.json merge:** a manifest `settings_merge` objektuma. A GSD hookjait és
   statuslinet ne bántsd.
7. **rtk:** a manifest `rtk` blokkja szerint. Nem kötelező. A hookot CSAK akkor vedd fel,
   ha az `ellenorzes` parancs működik.

## E FÁZIS — Verifikáció, kifejezetten duplikátumokra

- `claude plugin list` és `marketplace list` = pontosan a manifest tartalma, semmi több
- ne legyen olyan név, ami egyszerre van meg `~/.claude/{commands,skills}` alatt ÉS egy
  plugin skilljeként (külön nézd: alapcsomag, autopilot, handoff)
- minden `settings.json` hook-parancs létező fájlra mutasson
- írd ki, hogy indítson új sessiont és ellenőrizze: `/bajzi:handoff` létezik, `/context`
  bázis 20% alatt

## Zárójelentés

Táblázat: mi lett törölve · mi lett telepítve (tokenköltséggel) · mi maradt kézire · hol a
mentés. Ha valami nem fér a fenti kategóriákba, **ne dönts a felhasználó helyett** — tedd a
„kézire" listába.
