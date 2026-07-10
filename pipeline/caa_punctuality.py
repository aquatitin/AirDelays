#!/usr/bin/env python3
"""Ingesta de les estadístiques de puntualitat de la UK CAA.

Font: UK Civil Aviation Authority, «Flight punctuality statistics».
Fitxers CSV mensuals amb la puntualitat de cada combinació d'aeroport
declarant, aeroport de l'altre extrem, aerolínia i sentit
(arribada/sortida). Cobreix els principals aeroports del Regne Unit,
amb sèrie històrica mensual.

L'script recorre les pàgines anuals de la CAA, en descarrega els CSV
d'anàlisi completa (amb separació arribades/sortides), agrega per mes i
escriu docs/data/caa/.

Ús:
    python3 pipeline/caa_punctuality.py --years 2018 2025
    python3 pipeline/caa_punctuality.py --years 2024 2024 --probe
"""

from __future__ import annotations

import argparse
import csv
import datetime
import io
import os
import re
import sys
import urllib.error
from urllib.parse import urljoin

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datastore import Dataset, http_get  # noqa: E402

YEAR_PAGE = (
    "https://www.caa.co.uk/data-and-analysis/uk-aviation-market/"
    "flight-punctuality/uk-flight-punctuality-statistics/{year}/"
)

META = {
    "order": 2,
    "name": "Regne Unit — puntualitat per aeroport, aerolínia i ruta (CAA)",
    "url": "https://www.caa.co.uk/data-and-analysis/uk-aviation-market/flight-punctuality/",
    "attribution": "Font: UK Civil Aviation Authority",
    "rec": "caa",
    "dims": ["airport", "airline", "route", "country"],
    "note": (
        "Retards de totes les causes als aeroports declarants del Regne "
        "Unit. «País» és el país de l'altre extrem de la ruta; les rutes "
        "s'ancoren a l'aeroport britànic."
    ),
}

# rec "caa":
# [arr_vols, arr_cancel, arr_min_retard, arr_puntuals,
#  dep_vols, dep_cancel, dep_min_retard, dep_puntuals]
REC_LEN = 8

def resolve_ontime_cols(fieldnames: list[str]) -> list[str]:
    """Troba les columnes de percentatge «puntual (≤ 15 min)» del fitxer.

    Els fitxers moderns tenen tres trams (més de 15' aviat, 15'-1' aviat,
    0-15' tard); alguns d'antics tenen un tram combinat únic. S'ignoren
    les columnes de comparació amb l'any anterior.
    """
    keys = [str(k).strip().lower() for k in fieldnames if k]
    current = [k for k in keys if not k.startswith("previous")]
    # Els fitxers antics escriuen «mins»/«min» en lloc de «minutes»/«minute».
    combined = [k for k in current if re.search(r"early_to_15_min(ute)?s?_late", k)]
    if combined:
        return combined[:1]
    cols = []
    for pattern in (
        r"more_than_15_min(ute)?s?_early",
        r"15_min(ute)?s?_early_to_1_min",
        r"(?<!\d)0_to_15_min(ute)?s?_late",
    ):
        for k in current:
            if re.search(pattern, k):
                cols.append(k)
                break
    return cols


def find_csv_links(year: int) -> list[str]:
    url = YEAR_PAGE.format(year=year)
    try:
        html = http_get(url, retries=2, timeout=60).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        print(f"{year}: pàgina no disponible (HTTP {exc.code})")
        return []
    anchors = [
        (href, re.sub(r"<[^>]+>", " ", text).lower())
        for href, text in re.findall(
            r"""<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>""",
            html, flags=re.IGNORECASE | re.DOTALL,
        )
        # Els fitxers anuals repeteixen les dades mensuals agregades amb
        # el període de desembre (duplicarien l'any); els resums no tenen
        # el detall per aerolínia i ruta.
        if not re.search(r"annual|summary", text, re.IGNORECASE)
    ]
    # Enllaços directes a .csv (estructura antiga del web de la CAA).
    links = [href for href, _ in anchors if re.search(r"\.csv(\?|$)", href, re.IGNORECASE)]
    # Estructura actual: descàrregues de document sense extensió
    # (/Documents/Download/...). Es prefereixen els enllaços el text dels
    # quals menciona CSV; si no n'hi ha, es proven tots i el filtre de
    # contingut d'ingest_file descarta el que no toca.
    docs = [
        (href, text)
        for href, text in anchors
        if "/documents/download/" in href.lower()
    ]
    csvish = [href for href, text in docs if "csv" in text]
    links += csvish or [href for href, _ in docs]
    if not links:
        title = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        print(f"  diagnòstic {year}: {len(html)} bytes, títol={title.group(1).strip()[:80] if title else '?'}")
    return sorted({urljoin(url, link) for link in links})


def col(row: dict, *names: str):
    lowered = {str(k).strip().lower().lstrip("﻿"): v for k, v in row.items()}
    for name in names:
        if name.lower() in lowered:
            return lowered[name.lower()]
    return None


def to_float(value) -> float:
    if value in (None, "", "NA", "-"):
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def title(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().title()


def ingest_file(url: str, data: bytes, ds: Dataset, seen_periods: set[int], probe: bool) -> int:
    if data[:5] == b"%PDF-" or data[:4] == b"PK\x03\x04":  # PDF o Office: no és CSV
        return 0
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return 0
    header_check = col(rows[0], "arrival_departure")
    if header_check is None or col(rows[0], "reporting_airport") is None:
        print(f"  s'omet (no és l'anàlisi completa amb separació arr/dep): {os.path.basename(url)}")
        return 0
    if probe:
        print("  columnes:", list(rows[0].keys()))
        print("  primera fila:", rows[0])
        return 0

    ontime_cols = resolve_ontime_cols(list(rows[0].keys()))
    if not ontime_cols:
        print(f"  avís: sense columnes de puntualitat a {os.path.basename(url)}: {list(rows[0].keys())}")

    periods = {int(to_float(col(r, "reporting_period"))) for r in rows}
    new_periods = periods - seen_periods
    if not new_periods:
        return 0

    n = 0
    for row in rows:
        period = int(to_float(col(row, "reporting_period")))
        if period not in new_periods:
            continue
        year, month = divmod(period, 100)
        if not 1 <= month <= 12:
            continue

        airport = title(str(col(row, "reporting_airport") or ""))
        other = title(str(col(row, "origin_destination") or ""))
        airline = title(str(col(row, "airline_name") or ""))
        country = title(str(col(row, "origin_destination_country") or ""))
        direction = str(col(row, "arrival_departure") or "").strip().upper()[:1]
        if not airport or direction not in ("A", "D"):
            continue

        matched = int(to_float(col(row, "number_flights_matched")))
        cancelled = int(to_float(col(row, "number_flights_cancelled")))
        avg_delay = to_float(col(row, "average_delay_mins", "average_delay"))
        ontime_pct = sum(to_float(col(row, c)) for c in ontime_cols)

        delay_sum = int(round(avg_delay * matched))
        ontime = int(round(ontime_pct * matched / 100))

        base = [matched, cancelled, delay_sum, ontime]
        values = base + [0, 0, 0, 0] if direction == "A" else [0, 0, 0, 0] + base

        ds.add(year, month, "airport", airport, values)
        ds.set_name("airport", airport, airport)
        if airline:
            ds.add(year, month, "airline", airline, values)
            ds.set_name("airline", airline, airline)
        if other:
            route = f"{airport}|{other}"
            ds.add(year, month, "route", route, values)
            ds.set_name("route", route, f"{airport} ⇄ {other}")
        if country:
            ds.add(year, month, "country", country, values)
            ds.set_name("country", country, country)
        n += 1

    seen_periods.update(new_periods)
    return n


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--years",
        nargs=2,
        type=int,
        metavar=("INICI", "FI"),
        default=[2015, datetime.date.today().year],
    )
    parser.add_argument("--probe", action="store_true", help="mostra enllaços i capçaleres i surt")
    parser.add_argument(
        "--min-route-flights",
        type=int,
        default=100,
        help="descarta rutes amb menys vols anuals (per defecte 100)",
    )
    args = parser.parse_args()

    ds = Dataset("caa", META, REC_LEN)
    seen: set[int] = set()
    total = 0

    start, end = args.years
    for year in range(end, start - 1, -1):
        links = find_csv_links(year)
        print(f"{year}: {len(links)} fitxers CSV enllaçats")
        for url in links:
            if args.probe:
                print(f"  {url}")
        if args.probe and links:
            data = http_get(links[0], retries=2)
            ingest_file(links[0], data, ds, seen, probe=True)
            continue
        for url in links:
            try:
                data = http_get(url, retries=2)
            except Exception as exc:  # noqa: BLE001
                print(f"  error baixant {url}: {exc}")
                continue
            n = ingest_file(url, data, ds, seen, probe=False)
            if n:
                print(f"  {os.path.basename(url)}: {n} files")
                total += n

    if args.probe:
        return
    if not total:
        raise SystemExit("No s'ha ingerit cap fila; reviseu els enllaços/format de la CAA")

    ds.prune("route", args.min_route_flights)
    ds.write()
    print(f"Fet: {total} files agregades -> docs/data/caa/")


if __name__ == "__main__":
    main()
