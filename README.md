# AirDelays ✈️

Pàgina web estàtica amb **estadístiques històriques de retards de vols a
Europa** — per aeroport, país, aerolínia i ruta, mes a mes i any a any.
Sense servidor: un pipeline de Python agrega les dades oficials en JSON
compactes i el frontend (HTML/CSS/JS purs, sense dependències) els dibuixa.

## Fonts de dades

Es van avaluar les fonts fiables i obertes disponibles. No existeix cap font
**mundial** gratuïta de retards vol a vol (això és terreny de proveïdors
comercials com Cirium, OAG o FlightAware); per a Europa, les dues millors
fonts oficials són les que fa servir aquest projecte:

| Font | Cobertura | Granularitat | Des de | Què mesura |
|---|---|---|---|---|
| [EUROCONTROL — Airport Arrival ATFM Delay](https://ansperformance.eu/data/) | Tots els aeroports de l'àrea ECAC (~40 estats) | aeroport · país · mes | 2014 | Minuts de retard de regulació de trànsit aeri (ATFM) imputats a l'aeroport d'arribada: congestió d'aeroport i d'espai aeri. **No inclou** els retards propis de les aerolínies. |
| [UK CAA — Flight punctuality statistics](https://www.caa.co.uk/data-and-analysis/uk-aviation-market/flight-punctuality/) | Aeroports declarants del Regne Unit | aeroport · aerolínia · ruta · país de l'altre extrem · mes | ~2015 (en línia) | Retards de **totes les causes**: retard mitjà, puntualitat (≤ 15 min) i cancel·lacions, per a arribades i sortides. |

Fonts complementàries documentades però no integrades:

- **CODA (EUROCONTROL)** publica els retards de totes les causes per a tota
  Europa als [CODA Digests](https://www.eurocontrol.int/publication/all-causes-delays-air-transport-europe-annual-2024),
  però només en informes PDF trimestrals/anuals, no com a dades descarregables.
- **BTS (EUA)**: si mai es vol afegir Amèrica del Nord, el
  [Bureau of Transportation Statistics](https://www.transtats.bts.gov/ontime/)
  ofereix la sèrie vol a vol 1987–actualitat, amb la mateixa arquitectura
  d'agregació que aquest pipeline.

## Estructura

```
docs/                  ← la web (servible amb GitHub Pages)
  index.html
  styles.css
  app.js
  data/                ← JSON generats pel pipeline (un directori per font)
    manifest.json
    eurocontrol/2014.json … lookups.json
    caa/2015.json … lookups.json
pipeline/
  datastore.py         ← escriptura/fusió dels agregats
  eurocontrol_atfm.py  ← ingesta d'Eurocontrol
  caa_punctuality.py   ← ingesta de la UK CAA
.github/workflows/update-data.yml  ← actualització mensual automàtica
```

Els agregats mensuals guarden **comptadors** (vols, minuts acumulats,
vols puntuals, cancel·lats…), no pas mitjanes: el frontend deriva mitjanes i
percentatges exactes per a qualsevol període (mensual, anual o plurianual).

## Com s'actualitzen les dades

El workflow **«Actualitza les dades»** (GitHub Actions) s'executa el dia 20
de cada mes — i també manualment des de la pestanya *Actions* — i:

1. Baixa el conjunt complet d'Eurocontrol i els CSV mensuals de la CAA.
2. Regenera els JSON de `docs/data/`.
3. Fa commit dels canvis si n'hi ha.

Per executar el pipeline en local:

```bash
pip install openpyxl        # només cal per a la variant Excel d'Eurocontrol
python3 pipeline/eurocontrol_atfm.py
python3 pipeline/caa_punctuality.py --years 2015 2026
```

I per servir la web en local:

```bash
cd docs && python3 -m http.server 8000
```

## Publicació

Activeu GitHub Pages al repositori (*Settings → Pages → Deploy from a
branch*, carpeta `/docs`) i la web quedarà publicada; cada actualització
mensual de dades es desplega sola.

## Atribució

Dades: © EUROCONTROL (Aviation Intelligence Portal) i UK Civil Aviation
Authority. Aquest projecte no està afiliat a cap de les dues entitats.
