"""Escriptura dels agregats mensuals a docs/data/.

Estructura de sortida (un directori per conjunt de dades):

    docs/data/manifest.json               índex de conjunts de dades
    docs/data/<dataset>/<any>.json        agregats mensuals d'un any
    docs/data/<dataset>/lookups.json      noms per mostrar de cada clau

Format d'un fitxer anual:

    {"year": 2024,
     "dims": {"airport": {"LEBL": {"1": [reg], "2": [reg], ...}, ...},
              "country": {...}, ...}}

El contingut del registre [reg] depèn del conjunt de dades i està
descrit al manifest (camp "rec"); sempre són enters acumulables, de
manera que el client pot derivar mitjanes i percentatges exactes per a
qualsevol període.
"""

from __future__ import annotations

import datetime
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")


class Dataset:
    """Acumula registres mensuals i els fusiona amb els JSON existents."""

    def __init__(self, dataset_id: str, meta: dict, rec_len: int, out_dir: str = DATA_DIR):
        self.id = dataset_id
        self.meta = meta
        self.rec_len = rec_len
        self.out_dir = out_dir
        # years[any][dim][clau][mes] -> [enters]
        self.years: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))
        self.names: dict = defaultdict(dict)  # dim -> clau -> nom

    def add(self, year: int, month: int, dim: str, key: str, values: list) -> None:
        """Suma `values` al registre del mes (creant-lo si cal)."""
        bucket = self.years[year][dim][key]
        rec = bucket.get(month)
        if rec is None:
            rec = bucket[month] = [0] * self.rec_len
        for i, v in enumerate(values):
            rec[i] += int(round(v))

    def set_name(self, dim: str, key: str, name: str) -> None:
        if key and name:
            self.names[dim].setdefault(key, name)

    # ------------------------------------------------------------------ #

    def prune(self, dim: str, min_total: int, index: int = 0) -> None:
        """Elimina claus d'una dimensió amb poc volum anual (soroll)."""
        for dims in self.years.values():
            entries = dims.get(dim, {})
            for key in [
                k
                for k, months in entries.items()
                if sum(rec[index] for rec in months.values()) < min_total
            ]:
                del entries[key]

    def write(self, replace_years: bool = True) -> None:
        """Escriu els fitxers del conjunt de dades i actualitza el manifest.

        Amb replace_years=True (per defecte) cada any generat substitueix el
        fitxer existent; amb False, els mesos nous es fusionen amb els vells.
        """
        ds_dir = os.path.join(self.out_dir, self.id)
        os.makedirs(ds_dir, exist_ok=True)

        for year, dims in sorted(self.years.items()):
            path = os.path.join(ds_dir, f"{year}.json")
            payload = {"year": year, "dims": {}}
            if not replace_years and os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    payload = json.load(f)
                payload.setdefault("dims", {})
            for dim, entries in dims.items():
                out_dim = payload["dims"].setdefault(dim, {})
                for key, months in sorted(entries.items()):
                    entry = out_dim.setdefault(key, {})
                    for m, rec in sorted(months.items()):
                        entry[str(m)] = rec
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

        self._write_lookups(ds_dir)
        self._update_manifest()

    def _write_lookups(self, ds_dir: str) -> None:
        path = os.path.join(ds_dir, "lookups.json")
        lookups: dict = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                lookups = json.load(f)
        for dim, names in self.names.items():
            merged = lookups.setdefault(dim, {})
            for key, name in names.items():
                merged.setdefault(key, name)
            lookups[dim] = dict(sorted(merged.items()))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(lookups, f, ensure_ascii=False, separators=(",", ":"))

    def _update_manifest(self) -> None:
        path = os.path.join(self.out_dir, "manifest.json")
        manifest = {"datasets": []}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                manifest = json.load(f)

        ds_dir = os.path.join(self.out_dir, self.id)
        years = sorted(
            int(base)
            for base, ext in (os.path.splitext(n) for n in os.listdir(ds_dir))
            if ext == ".json" and base.isdigit()
        )

        entry = dict(self.meta)
        entry["id"] = self.id
        entry["years"] = years

        datasets = [d for d in manifest.get("datasets", []) if d.get("id") != self.id]
        datasets.append(entry)
        datasets.sort(key=lambda d: d.get("order", 99))
        manifest["datasets"] = datasets
        manifest["generated"] = datetime.date.today().isoformat()

        with open(path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)


def http_get(url: str, dest: str | None = None, retries: int = 4, timeout: int = 300) -> bytes:
    """GET amb reintents exponencials i User-Agent de navegador."""
    import time
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
            ),
            "Accept": "*/*",
        },
    )
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if dest:
                with open(dest, "wb") as f:
                    f.write(data)
            return data
        except Exception as exc:  # noqa: BLE001 — es rellança al final
            last_exc = exc
            code = getattr(exc, "code", None)
            if code in (404, 410):
                raise
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
    raise last_exc  # type: ignore[misc]
