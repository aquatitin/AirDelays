/* AirDelays — frontend estàtic.
   Llegeix els agregats mensuals de docs/data/ (generats pel pipeline) i
   dibuixa KPI, evolució mensual, mapa de calor anys×mesos, rànquing i
   taula. Sense dependències externes. */

"use strict";

/* ------------------------------------------------------------------ */
/* Configuració                                                        */
/* ------------------------------------------------------------------ */

const MONTHS = ["gen", "febr", "març", "abr", "maig", "juny",
                "jul", "ag", "set", "oct", "nov", "des"];

const DIM_LABELS = {
  airport: "Aeroports",
  country: "Països",
  airline: "Aerolínies",
  route: "Rutes",
};

const nfInt = new Intl.NumberFormat("ca-ES", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ca-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtInt = (v) => nfInt.format(v);
const fmt1 = (v) => nf1.format(v);

/* Tipus de registre per conjunt de dades. Les funcions value() reben el
   registre "plegat" (fold) del període: ec → [arribades, minuts]; caa →
   [vols, cancel·lats, minuts, puntuals]. bad: +1 = pujar és dolent. */
const REC_TYPES = {
  ec: {
    hasDir: false,
    fold: (rec) => rec,
    metrics: [
      { id: "atfm", label: "Retard ATFM mitjà per arribada", short: "Retard ATFM/vol",
        bad: 1, value: (r) => (r[0] ? r[1] / r[0] : null), fmt: (v) => `${fmt1(v)} min` },
      { id: "totmin", label: "Minuts totals de retard ATFM", short: "Minuts de retard",
        bad: 1, value: (r) => r[1], fmt: fmtInt },
      { id: "flights", label: "Arribades", short: "Arribades",
        bad: 0, value: (r) => r[0], fmt: fmtInt },
    ],
    kpis: ["flights", "atfm", "totmin"],
    flightsOf: (r) => r[0],
  },
  caa: {
    hasDir: true,
    fold: (rec, dir) => {
      if (dir === "D") return rec.slice(4, 8);
      if (dir === "T") return [rec[0] + rec[4], rec[1] + rec[5], rec[2] + rec[6], rec[3] + rec[7]];
      return rec.slice(0, 4);
    },
    metrics: [
      { id: "avg", label: "Retard mitjà", short: "Retard mitjà",
        bad: 1, value: (r) => (r[0] ? r[2] / r[0] : null), fmt: (v) => `${fmt1(v)} min` },
      { id: "ontime", label: "Puntualitat (≤ 15 min)", short: "Puntualitat",
        bad: -1, value: (r) => (r[0] ? (100 * r[3]) / r[0] : null), fmt: (v) => `${fmt1(v)} %` },
      { id: "cancel", label: "Cancel·lacions", short: "Cancel·lacions",
        bad: 1, value: (r) => (r[0] + r[1] ? (100 * r[1]) / (r[0] + r[1]) : null), fmt: (v) => `${fmt1(v)} %` },
      { id: "flights", label: "Vols", short: "Vols",
        bad: 0, value: (r) => r[0], fmt: fmtInt },
    ],
    kpis: ["flights", "avg", "ontime", "cancel"],
    flightsOf: (r) => r[0],
  },
};

/* Rampes seqüencials validades (mapa de calor): clar i fosc. */
const RAMP_LIGHT = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const RAMP_DARK = ["#184f95", "#256abf", "#3987e5", "#86b6ef", "#cde2fb"];

const RANK_N = 15;
const MIN_FLIGHTS_PER_MONTH = 30; // elegibilitat al rànquing

/* ------------------------------------------------------------------ */
/* Estat i dades                                                       */
/* ------------------------------------------------------------------ */

const state = {
  ds: null, dim: "airport", entity: null,
  metric: null, dir: "A", period: "all",
  rankOrder: "desc", tableSort: { col: 1, dir: -1 },
};

let manifest = null;
const loaded = {}; // dsId -> {lookups, entities: {dim: Map}, yms: [..], totals: {dim: Map}}

const $ = (id) => document.getElementById(id);
const svgNS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(svgNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function ymKey(y, m) { return y * 12 + (m - 1); }
function ymLabel(ym) { return `${MONTHS[ym % 12]} ${Math.floor(ym / 12)}`; }

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp.json();
}

async function loadDataset(dsId) {
  if (loaded[dsId]) return loaded[dsId];
  const meta = manifest.datasets.find((d) => d.id === dsId);
  const [lookups, ...yearFiles] = await Promise.all([
    fetchJSON(`data/${dsId}/lookups.json`).catch(() => ({})),
    ...meta.years.map((y) => fetchJSON(`data/${dsId}/${y}.json`)),
  ]);

  const entities = {};
  const ymSet = new Set();
  for (const yf of yearFiles) {
    for (const [dim, keys] of Object.entries(yf.dims || {})) {
      const map = (entities[dim] ||= new Map());
      for (const [key, months] of Object.entries(keys)) {
        let ent = map.get(key);
        if (!ent) {
          const name = (lookups[dim] || {})[key] || key;
          ent = { key, name, months: new Map() };
          map.set(key, ent);
        }
        for (const [m, rec] of Object.entries(months)) {
          const ym = ymKey(yf.year, Number(m));
          ent.months.set(ym, rec);
          ymSet.add(ym);
        }
      }
    }
  }

  const totals = {};
  for (const [dim, map] of Object.entries(entities)) {
    const t = new Map();
    for (const ent of map.values()) {
      for (const [ym, rec] of ent.months) {
        let acc = t.get(ym);
        if (!acc) { acc = rec.map(() => 0); t.set(ym, acc); }
        rec.forEach((v, i) => { acc[i] += v; });
      }
    }
    totals[dim] = t;
  }

  loaded[dsId] = { meta, lookups, entities, totals, yms: [...ymSet].sort((a, b) => a - b) };
  return loaded[dsId];
}

/* ------------------------------------------------------------------ */
/* Utilitats de càlcul                                                 */
/* ------------------------------------------------------------------ */

function recType() { return REC_TYPES[loaded[state.ds].meta.rec]; }
function currentMetric() {
  const rt = recType();
  return rt.metrics.find((m) => m.id === state.metric) || rt.metrics[0];
}

function periodYms(data) {
  const all = data.yms;
  if (!all.length) return [];
  if (state.period === "all") return all;
  const last = all[all.length - 1];
  const cut = last - Number(state.period) * 12;
  return all.filter((ym) => ym > cut);
}

function foldSum(months, yms, dir) {
  const rt = recType();
  let acc = null;
  for (const ym of yms) {
    const rec = months.get(ym);
    if (!rec) continue;
    const f = rt.fold(rec, dir);
    if (!acc) acc = f.slice();
    else f.forEach((v, i) => { acc[i] += v; });
  }
  return acc;
}

function seriesFor(months, yms, metric, dir) {
  const rt = recType();
  return yms.map((ym) => {
    const rec = months.get(ym);
    return rec ? metric.value(rt.fold(rec, dir)) : null;
  });
}

function niceTicks(min, max, n = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => span / s <= n) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function rampColor(t) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const hex = (c) => [1, 3, 5].map((p) => parseInt(c.slice(p, p + 2), 16));
  const [a, b] = [hex(ramp[i]), hex(ramp[i + 1])];
  const mix = a.map((v, j) => Math.round(v + (b[j] - v) * f));
  return `rgb(${mix.join(",")})`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ------------------------------------------------------------------ */
/* Tooltips                                                            */
/* ------------------------------------------------------------------ */

function showTip(tip, box, x, y, title, rows) {
  tip.replaceChildren();
  const t = document.createElement("div");
  t.className = "t-title";
  t.textContent = title;
  tip.appendChild(t);
  for (const { key, color, val } of rows) {
    const row = document.createElement("div");
    row.className = "t-row";
    const k = document.createElement("span");
    k.className = "t-key";
    if (color) {
      const swatch = document.createElement("i");
      swatch.style.borderTopColor = color;
      k.appendChild(swatch);
    }
    k.appendChild(document.createTextNode(key));
    const v = document.createElement("span");
    v.className = "t-val";
    v.textContent = val;
    row.append(k, v);
    tip.appendChild(row);
  }
  tip.style.display = "block";
  const bw = box.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14;
  if (left + tw > bw - 4) left = x - tw - 14;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, Math.min(y - th / 2, box.clientHeight - th - 4))}px`;
}

function hideTip(tip) { tip.style.display = "none"; }

/* ------------------------------------------------------------------ */
/* Filtres                                                             */
/* ------------------------------------------------------------------ */

function renderFilters() {
  const dsSel = $("f-dataset");
  dsSel.replaceChildren();
  for (const d of manifest.datasets) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.name;
    dsSel.appendChild(opt);
  }
  dsSel.value = state.ds;

  const data = loaded[state.ds];
  const dims = data.meta.dims.filter((d) => data.entities[d]);
  const dimBox = $("f-dim");
  dimBox.replaceChildren();
  for (const dim of dims) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = DIM_LABELS[dim] || dim;
    b.setAttribute("aria-pressed", String(dim === state.dim));
    b.addEventListener("click", () => { state.dim = dim; state.entity = null; update(); });
    dimBox.appendChild(b);
  }

  const rt = recType();
  const mSel = $("f-metric");
  mSel.replaceChildren();
  for (const m of rt.metrics) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    mSel.appendChild(opt);
  }
  mSel.value = currentMetric().id;

  $("dir-box").hidden = !rt.hasDir;
  $("f-dir").value = state.dir;
  $("f-period").value = state.period;

  const dl = $("entity-list");
  dl.replaceChildren();
  const ents = [...data.entities[state.dim].values()].sort((a, b) => a.name.localeCompare(b.name, "ca"));
  for (const ent of ents) {
    const opt = document.createElement("option");
    opt.value = displayName(ent);
    dl.appendChild(opt);
  }
  const input = $("f-entity");
  const sel = data.entities[state.dim].get(state.entity);
  input.value = sel ? displayName(sel) : "";
  input.placeholder = `Cerca entre ${ents.length} ${(DIM_LABELS[state.dim] || "").toLowerCase()}…`;
}

function displayName(ent) {
  return ent.name === ent.key ? ent.name : `${ent.name} (${ent.key})`;
}

function entityFromInput(value) {
  const data = loaded[state.ds];
  const map = data.entities[state.dim];
  for (const ent of map.values()) {
    if (displayName(ent) === value || ent.name === value || ent.key === value) return ent.key;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* KPI                                                                 */
/* ------------------------------------------------------------------ */

function renderKpis(months, yms) {
  const rt = recType();
  const box = $("kpis");
  box.replaceChildren();
  const all = loaded[state.ds].yms;
  const last = all[all.length - 1];
  const cur12 = all.filter((ym) => ym > last - 12);
  const prev12 = all.filter((ym) => ym > last - 24 && ym <= last - 12);

  const total = foldSum(months, yms, state.dir);
  const cur = foldSum(months, cur12, state.dir);
  const prev = prev12.length >= 12 ? foldSum(months, prev12, state.dir) : null;

  for (const id of rt.kpis) {
    const m = rt.metrics.find((x) => x.id === id);
    const tile = document.createElement("div");
    tile.className = "tile";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = m.label;
    const value = document.createElement("div");
    value.className = "value";
    const v = total ? m.value(total) : null;
    value.textContent = v == null ? "—" : m.fmt(v);
    tile.append(label, value);

    if (prev && cur) {
      const cv = m.value(cur), pv = m.value(prev);
      if (cv != null && pv != null && pv !== 0) {
        const delta = document.createElement("div");
        delta.className = "delta";
        const pct = (100 * (cv - pv)) / Math.abs(pv);
        const arrow = document.createElement("span");
        const up = pct >= 0;
        if (m.bad !== 0) {
          const isBad = (pct >= 0) === (m.bad > 0);
          arrow.className = isBad ? "dir-bad" : "dir-good";
        }
        arrow.textContent = `${up ? "▲" : "▼"} ${fmt1(Math.abs(pct))} %`;
        delta.append(arrow, document.createTextNode(" darrers 12 mesos vs. anteriors"));
        tile.appendChild(delta);
      }
    }
    box.appendChild(tile);
  }
}

/* ------------------------------------------------------------------ */
/* Gràfic de línies                                                    */
/* ------------------------------------------------------------------ */

function renderTrend(entity, yms) {
  const data = loaded[state.ds];
  const metric = currentMetric();
  const svg = $("trend-svg");
  svg.replaceChildren();
  const tip = $("trend-tip"), box = $("trend-box");

  const totalSeries = seriesFor(data.totals[state.dim], yms, metric, state.dir);
  const entSeries = entity ? seriesFor(entity.months, yms, metric, state.dir) : null;

  $("trend-title").textContent = `Evolució mensual — ${metric.label}`;
  $("trend-sub").textContent = entity
    ? `${displayName(entity)} comparat amb el conjunt de la xarxa.`
    : "Conjunt de la xarxa. Seleccioneu un element per comparar-lo.";

  const legend = $("trend-legend");
  legend.replaceChildren();
  if (entSeries) {
    for (const [name, color] of [[displayName(entity), cssVar("--series-1")], ["Conjunt de la xarxa", cssVar("--deemph")]]) {
      const k = document.createElement("span");
      k.className = "key";
      const i = document.createElement("i");
      i.style.borderTopColor = color;
      k.append(i, document.createTextNode(name));
      legend.appendChild(k);
    }
  }

  const W = 960, H = 300, L = 52, R = 14, T = 10, B = 26;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const values = [...totalSeries, ...(entSeries || [])].filter((v) => v != null);
  if (!values.length || yms.length < 2) return;

  let vmin = Math.min(0, ...values), vmax = Math.max(...values);
  if (vmin === vmax) vmax = vmin + 1;
  const pad = (vmax - vmin) * 0.06;
  vmax += pad; if (vmin < 0) vmin -= pad;

  const x = (i) => L + (i * (W - L - R)) / (yms.length - 1);
  const y = (v) => T + (H - T - B) * (1 - (v - vmin) / (vmax - vmin));

  for (const tv of niceTicks(vmin, vmax)) {
    el("line", { class: "gridline", x1: L, x2: W - R, y1: y(tv), y2: y(tv) }, svg);
    el("text", { x: L - 8, y: y(tv) + 4, "text-anchor": "end" }, svg).textContent = fmtInt(tv);
  }
  el("line", { class: "axis", x1: L, x2: W - R, y1: y(Math.max(0, vmin)), y2: y(Math.max(0, vmin)) }, svg);

  let lastYear = null;
  yms.forEach((ym, i) => {
    const year = Math.floor(ym / 12);
    if (year !== lastYear) {
      lastYear = year;
      if (yms.length <= 30 || ym % 12 === 0) {
        el("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, svg).textContent = year;
      }
    }
  });

  const path = (series) => {
    let d = "", drawing = false;
    series.forEach((v, i) => {
      if (v == null) { drawing = false; return; }
      d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      drawing = true;
    });
    return d;
  };

  el("path", { d: path(totalSeries), fill: "none", stroke: cssVar("--deemph"),
               "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  if (entSeries) {
    el("path", { d: path(entSeries), fill: "none", stroke: cssVar("--series-1"),
                 "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  }

  const cursor = el("g", { style: "display:none" }, svg);
  const cline = el("line", { class: "axis", y1: T, y2: H - B }, cursor);
  const dots = [
    entSeries ? el("circle", { r: 5, fill: cssVar("--series-1"), stroke: cssVar("--surface-1"), "stroke-width": 2 }, cursor) : null,
    el("circle", { r: 5, fill: cssVar("--deemph"), stroke: cssVar("--surface-1"), "stroke-width": 2 }, cursor),
  ];

  const overlay = el("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }, svg);
  overlay.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(yms.length - 1, Math.round(((px - L) / (W - L - R)) * (yms.length - 1))));
    cursor.style.display = "";
    cline.setAttribute("x1", x(i));
    cline.setAttribute("x2", x(i));
    const rows = [];
    if (entSeries) {
      const v = entSeries[i];
      if (v != null) { dots[0].style.display = ""; dots[0].setAttribute("cx", x(i)); dots[0].setAttribute("cy", y(v)); }
      else dots[0].style.display = "none";
      rows.push({ key: entity.name, color: cssVar("--series-1"), val: v == null ? "—" : metric.fmt(v) });
    }
    const tv = totalSeries[i];
    if (tv != null) { dots[1].style.display = ""; dots[1].setAttribute("cx", x(i)); dots[1].setAttribute("cy", y(tv)); }
    else dots[1].style.display = "none";
    rows.push({ key: "Conjunt de la xarxa", color: cssVar("--deemph"), val: tv == null ? "—" : metric.fmt(tv) });
    const bx = (x(i) / W) * box.clientWidth;
    const by = (y(tv ?? vmax) / H) * box.clientHeight;
    showTip(tip, box, bx, by, ymLabel(yms[i]), rows);
  });
  overlay.addEventListener("pointerleave", () => { cursor.style.display = "none"; hideTip(tip); });
}

/* ------------------------------------------------------------------ */
/* Mapa de calor                                                       */
/* ------------------------------------------------------------------ */

function renderHeat(entity, yms) {
  const data = loaded[state.ds];
  const metric = currentMetric();
  const svg = $("heat-svg");
  svg.replaceChildren();
  const tip = $("heat-tip"), box = $("heat-box");
  const rt = recType();

  const months = entity ? entity.months : data.totals[state.dim];
  $("heat-title").textContent = "Mapa de calor: anys × mesos";
  $("heat-sub").textContent = `${metric.label} de ${entity ? displayName(entity) : "el conjunt de la xarxa"}, cada mes de la sèrie històrica.`;

  const years = [...new Set(yms.map((ym) => Math.floor(ym / 12)))].sort();
  const cells = [];
  let vmin = Infinity, vmax = -Infinity;
  for (const year of years) {
    for (let m = 0; m < 12; m++) {
      const ym = year * 12 + m;
      if (!yms.includes(ym)) continue;
      const rec = months.get(ym);
      const v = rec ? metric.value(rt.fold(rec, state.dir)) : null;
      if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
      cells.push({ year, m, v });
    }
  }
  if (!cells.length || vmin === Infinity) return;
  if (vmin === vmax) vmax = vmin + 1;

  const CW = 40, CH = 20, GX = 42, GY = 22, L = 56, T = 20;
  const W = L + 12 * GX + 6, H = T + years.length * GY + 4;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  MONTHS.forEach((mo, m) => {
    el("text", { x: L + m * GX + CW / 2, y: T - 7, "text-anchor": "middle" }, svg).textContent = mo;
  });
  years.forEach((year, r) => {
    el("text", { x: L - 8, y: T + r * GY + CH / 2 + 4, "text-anchor": "end" }, svg).textContent = year;
  });

  for (const c of cells) {
    const r = years.indexOf(c.year);
    const attrs = {
      x: L + c.m * GX, y: T + r * GY, width: CW, height: CH, rx: 3,
    };
    if (c.v == null) {
      el("rect", { ...attrs, fill: "none", stroke: cssVar("--grid") }, svg);
      continue;
    }
    const rect = el("rect", { ...attrs, fill: rampColor((c.v - vmin) / (vmax - vmin)) }, svg);
    rect.addEventListener("pointermove", (ev) => {
      const bRect = box.getBoundingClientRect();
      showTip(tip, box, ev.clientX - bRect.left, ev.clientY - bRect.top,
        `${MONTHS[c.m]} ${c.year}`, [{ key: metric.short, color: null, val: metric.fmt(c.v) }]);
    });
    rect.addEventListener("pointerleave", () => hideTip(tip));
  }

  const scale = $("heat-scale");
  scale.replaceChildren();
  const lo = document.createElement("span");
  lo.textContent = metric.fmt(vmin);
  const bar = document.createElement("div");
  bar.className = "bar";
  const stops = (window.matchMedia("(prefers-color-scheme: dark)").matches ? RAMP_DARK : RAMP_LIGHT).join(",");
  bar.style.background = `linear-gradient(90deg, ${stops})`;
  const hi = document.createElement("span");
  hi.textContent = metric.fmt(vmax);
  scale.append(lo, bar, hi);
}

/* ------------------------------------------------------------------ */
/* Rànquing                                                            */
/* ------------------------------------------------------------------ */

function rankRows(yms) {
  const data = loaded[state.ds];
  const rt = recType();
  const metric = currentMetric();
  const minFlights = MIN_FLIGHTS_PER_MONTH * Math.max(1, yms.length);
  const rows = [];
  for (const ent of data.entities[state.dim].values()) {
    const folded = foldSum(ent.months, yms, state.dir);
    if (!folded) continue;
    const flights = rt.flightsOf(folded);
    const v = metric.value(folded);
    if (v == null) continue;
    rows.push({ ent, v, flights, eligible: flights >= minFlights });
  }
  return rows;
}

function renderRank(rows) {
  const metric = currentMetric();
  const svg = $("rank-svg");
  svg.replaceChildren();
  const tip = $("rank-tip"), box = $("rank-box");

  $("rank-title").textContent = `Rànquing — ${metric.label}`;
  $("rank-sub").textContent =
    `Els ${RANK_N} primers del període seleccionat (mínim ${MIN_FLIGHTS_PER_MONTH} vols/mes de mitjana). Feu clic per seleccionar.`;

  const list = rows.filter((r) => r.eligible)
    .sort((a, b) => (state.rankOrder === "desc" ? b.v - a.v : a.v - b.v))
    .slice(0, RANK_N);
  if (!list.length) return;

  const W = 960, LH = 26, BAR = 18, L = 250, R = 90, T = 4;
  const H = T + list.length * LH + 6;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const vmax = Math.max(...list.map((r) => Math.abs(r.v)), 1e-9);
  const x0 = L;
  const bw = (v) => (Math.abs(v) / vmax) * (W - L - R);

  el("line", { class: "axis", x1: x0, x2: x0, y1: T, y2: H - 4 }, svg);

  list.forEach((r, i) => {
    const yTop = T + i * LH + (LH - BAR) / 2;
    const g = el("g", { class: "bar-row", tabindex: 0, role: "button" }, svg);
    g.setAttribute("aria-label", `${displayName(r.ent)}: ${metric.fmt(r.v)}`);

    const name = displayName(r.ent);
    const label = el("text", { class: "name", x: x0 - 10, y: yTop + BAR - 5, "text-anchor": "end" }, g);
    label.textContent = name.length > 34 ? `${name.slice(0, 33)}…` : name;

    /* Barra: extrem de dades arrodonit (4px), quadrat a la línia base. */
    const w = Math.max(bw(r.v), 1.5);
    el("path", {
      d: `M${x0},${yTop} h${Math.max(w - 4, 0)} a4,4 0 0 1 4,4 v${BAR - 8} a4,4 0 0 1 -4,4 h-${Math.max(w - 4, 0)} z`,
      fill: cssVar("--series-1"),
    }, g);
    const val = el("text", { class: "dlabel", x: x0 + w + 8, y: yTop + BAR - 5 }, g);
    val.textContent = metric.fmt(r.v);

    const activate = () => { setEntity(r.ent.key); };
    g.addEventListener("click", activate);
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(); } });
    const hover = (ev) => {
      const bRect = box.getBoundingClientRect();
      const px = ev.clientX != null ? ev.clientX - bRect.left : (x0 / W) * box.clientWidth;
      const py = ev.clientY != null ? ev.clientY - bRect.top : ((yTop + BAR / 2) / H) * box.clientHeight;
      showTip(tip, box, px, py, name, [
        { key: metric.short, color: null, val: metric.fmt(r.v) },
        { key: "Vols del període", color: null, val: fmtInt(r.flights) },
      ]);
    };
    g.addEventListener("pointermove", hover);
    g.addEventListener("focus", hover);
    g.addEventListener("pointerleave", () => hideTip(tip));
    g.addEventListener("blur", () => hideTip(tip));
  });
}

/* ------------------------------------------------------------------ */
/* Taula                                                               */
/* ------------------------------------------------------------------ */

function renderTable(rows) {
  const rt = recType();
  const table = $("data-table");
  table.replaceChildren();

  const cols = [{ id: "name", label: DIM_LABELS[state.dim] || "Element" },
                ...rt.metrics.map((m) => ({ id: m.id, label: m.label, metric: m }))];

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  cols.forEach((c, idx) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    th.scope = "col";
    const active = state.tableSort.col === idx;
    th.setAttribute("aria-sort", active ? (state.tableSort.dir > 0 ? "ascending" : "descending") : "none");
    th.addEventListener("click", () => {
      state.tableSort = { col: idx, dir: active ? -state.tableSort.dir : (idx === 0 ? 1 : -1) };
      renderTable(rows);
    });
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const idx = state.tableSort.col;
  const dir = state.tableSort.dir;
  const sorted = [...rows].sort((a, b) => {
    if (idx === 0) return dir * displayName(a.ent).localeCompare(displayName(b.ent), "ca");
    const m = cols[idx].metric;
    const av = m.value(a.folded), bv = m.value(b.folded);
    return dir * ((av ?? -Infinity) - (bv ?? -Infinity));
  });

  const tbody = document.createElement("tbody");
  for (const r of sorted) {
    const tr = document.createElement("tr");
    if (r.ent.key === state.entity) tr.className = "selected";
    const td0 = document.createElement("td");
    td0.textContent = displayName(r.ent);
    tr.appendChild(td0);
    for (const c of cols.slice(1)) {
      const td = document.createElement("td");
      const v = c.metric.value(r.folded);
      td.textContent = v == null ? "—" : c.metric.fmt(v);
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => setEntity(r.ent.key));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

/* ------------------------------------------------------------------ */
/* Orquestració                                                        */
/* ------------------------------------------------------------------ */

function setEntity(key) {
  state.entity = state.entity === key ? null : key;
  update();
}

function writeHash() {
  const params = new URLSearchParams();
  params.set("ds", state.ds);
  params.set("dim", state.dim);
  if (state.entity) params.set("e", state.entity);
  params.set("m", currentMetric().id);
  if (recType().hasDir) params.set("dir", state.dir);
  params.set("p", state.period);
  history.replaceState(null, "", `#${params.toString()}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("ds")) state.ds = params.get("ds");
  if (params.get("dim")) state.dim = params.get("dim");
  if (params.get("e")) state.entity = params.get("e");
  if (params.get("m")) state.metric = params.get("m");
  if (params.get("dir")) state.dir = params.get("dir");
  if (params.get("p")) state.period = params.get("p");
}

async function update() {
  const main = $("main");
  main.classList.add("loading");
  try {
    const data = await loadDataset(state.ds);
    if (!data.meta.dims.includes(state.dim) || !data.entities[state.dim]) {
      state.dim = data.meta.dims.find((d) => data.entities[d]) || data.meta.dims[0];
    }
    const rt = REC_TYPES[data.meta.rec];
    if (!rt.metrics.some((m) => m.id === state.metric)) state.metric = rt.metrics[0].id;
    if (!rt.hasDir) state.dir = "A";

    renderFilters();

    const yms = periodYms(data);
    const entity = state.entity ? data.entities[state.dim].get(state.entity) : null;
    if (state.entity && !entity) state.entity = null;

    const kpiMonths = entity ? entity.months : data.totals[state.dim];
    renderKpis(kpiMonths, yms);
    renderTrend(entity, yms);
    renderHeat(entity, yms);

    const rows = rankRows(yms).map((r) => ({ ...r, folded: foldSum(r.ent.months, yms, state.dir) }));
    renderRank(rows);
    renderTable(rows);
    writeHash();
  } finally {
    main.classList.remove("loading");
  }
}

function bindControls() {
  $("f-dataset").addEventListener("change", (ev) => {
    state.ds = ev.target.value;
    state.entity = null;
    update();
  });
  $("f-metric").addEventListener("change", (ev) => { state.metric = ev.target.value; update(); });
  $("f-dir").addEventListener("change", (ev) => { state.dir = ev.target.value; update(); });
  $("f-period").addEventListener("change", (ev) => { state.period = ev.target.value; update(); });
  $("f-entity").addEventListener("change", (ev) => {
    state.entity = entityFromInput(ev.target.value.trim());
    update();
  });
  $("rank-desc").addEventListener("click", () => {
    state.rankOrder = "desc";
    $("rank-desc").setAttribute("aria-pressed", "true");
    $("rank-asc").setAttribute("aria-pressed", "false");
    update();
  });
  $("rank-asc").addEventListener("click", () => {
    state.rankOrder = "asc";
    $("rank-desc").setAttribute("aria-pressed", "false");
    $("rank-asc").setAttribute("aria-pressed", "true");
    update();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => update());
}

async function init() {
  try {
    manifest = await fetchJSON("data/manifest.json");
  } catch {
    manifest = { datasets: [] };
  }
  if (!manifest.datasets.length) {
    const n = $("notice");
    n.hidden = false;
    n.textContent =
      "Encara no hi ha dades publicades. Executeu el workflow «Actualitza les dades» " +
      "del repositori (GitHub Actions) perquè baixi les sèries d'Eurocontrol i de la CAA.";
    return;
  }
  readHash();
  if (!manifest.datasets.some((d) => d.id === state.ds)) state.ds = manifest.datasets[0].id;
  bindControls();
  await update();
}

init();
