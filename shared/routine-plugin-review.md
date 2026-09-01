# Havi plugin-szemle — kész routine-prompt

Ez a (b) réteg: „megjelent-e valami, ami jobb annál, amit használok?" Ez ítélet, nem script.

Beállítás Claude Code-ban: `/schedule` → havi futás, ezzel a prompttal. (Vagy kézzel,
hónap elején, egy külön sessionben.)

---

```
Havi plugin-szemle. Röviden dolgozz, a végén MAXIMUM 5 tétel.

1. Olvasd be a kívánt állapotot:
   ~/.claude/plugins/marketplaces/bajzi-plugins/bajzi/skills/setup/manifest.json
   Ebben van a `plugins` lista (amit használok) ÉS a `tudatosan_kihagyva` lista
   azzal együtt, hogy MIÉRT hagytam ki. A kihagyottakat NE ajánld újra, hacsak a
   kihagyás indoka már nem érvényes — és akkor írd le, mi változott.

2. Frissítsd és nézd át a katalógust:
   claude plugin marketplace update
   claude plugin list --json
   Majd a ~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json fájlokból
   nézd meg, mi van kínálatban.

3. Csak azt jelentsd, ami DÖNTÉST igényel:
   - olyan új plugin, ami a jelenlegi készletemben lévő valamelyiket KIVÁLTANÁ (mondd
     meg, melyiket és miben jobb), vagy olyan hiányt tölt be, amit a manifest nem fed
   - olyan plugin, amit használok, de láthatóan elhagyatott (régóta nincs frissítés)
   - NE sorold fel, ami változatlan; ne ismételd a múlt havi javaslatokat

4. ELLÁTÁSI LÁNC — a telepített, HARMADIK FÉLTŐL származó pluginokra (nem az enyém,
   nem az anthropics/* alattiak). Mindegyikre nézd meg a forrásrepót, és jelezd, ha:
   - gazdát vagy karbantartót váltott (új owner, átnevezett repó, átadott hozzáférés)
   - archiválva lett, vagy hónapok óta nincs commit (elhagyatott — a hookjai viszont
     továbbra is kódot futtatnak a gépemen)
   - a telepítéshez képest ÚJ hook-típust vagy MCP-szervert vezetett be
   - futásidőben tölt le és futtat bármit az internetről (pl. a claude-mem a Bunt)
   Ez nem paranoia: a pluginok hookjai minden sessionben kódot futtatnak nálam, tehát
   ezek a repók a gépem ellátási lánca. Ha valami gyanús, ÍRD MEG, de ne javíts.

5. Minden javaslatnál add meg a tokenköltséget is:
   claude plugin details <név>   (telepítés után mérhető; ha nincs telepítve, becsüld
   a skillek számából, és jelezd, hogy becslés)

6. Zárás: ha van elfogadható javaslat, írd meg PONTOSAN, hogyan módosítanám a
   manifest.json-t (melyik sor kerül a `plugins` vagy a `tudatosan_kihagyva` listába,
   milyen `why` indoklással). A fájlt magát NE módosítsd — az az én döntésem.
```

---

## A gépi réteg (a)

`~/.local/bin/claude-plugin-check` — heti systemd timer, csak a TELEPÍTETT pluginok
verzió-eltérését jelenti, és `update-monitor note`-tal beszól (Telegram + e-mail).
Nem telepít és nem frissít semmit.

Kézzel: `claude-plugin-check` · csak eltéréskor írjon: `--quiet` · riasztás nélkül: `--no-note`
