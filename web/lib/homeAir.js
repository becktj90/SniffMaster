/**
 * homeAir.js — "Home mode" analytics: whole-home air quality, particulate,
 * biological (mold / dust-mite) and comfort metrics derived from the latest
 * snapshot, recent history, and optional outdoor data.
 *
 * Pure functions only (no I/O) so they are easy to unit-test.
 *
 * Honesty rules baked in:
 *   - The stock device is a Bosch BME688. It measures temperature, humidity,
 *     pressure and gas resistance; IAQ / bVOC / CO2-equivalent are MODEL
 *     ESTIMATES. It does NOT measure particulates, formaldehyde, or allergens.
 *   - Optional sensor fields (pm1/pm25/pm4/pm10, co2True, hcho, vocIndex,
 *     noxIndex) are used only when the device actually posts them. Every
 *     metric is tagged with its source so the dashboard never presents an
 *     estimate as a measurement.
 *   - Mold / dust-mite scores are exposure heuristics from humidity and
 *     temperature history, not lab tests.
 */

const MS_H = 3600 * 1000;

export function num(v, fallback = NaN) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Piecewise-linear lookup. `table` is [[x0,y0],[x1,y1],...] sorted by x. */
export function interp(x, table) {
  if (!Number.isFinite(x)) return NaN;
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

// ── Psychrometrics ─────────────────────────────────────────────────────────

/** Dew point (°C) via the Magnus formula. */
export function dewPointC(tempC, rh) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh) || rh <= 0) return NaN;
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(clamp(rh, 0.1, 100) / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Absolute humidity in g/m³. */
export function absoluteHumidity(tempC, rh) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh)) return NaN;
  const es = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5)); // hPa
  return (es * rh * 2.1674) / (273.15 + tempC);
}

// ── Particulate ────────────────────────────────────────────────────────────

// US EPA AQI breakpoints. PM2.5 uses the 2024 revision (Good ≤ 9.0 µg/m³).
const PM25_BP = [
  [0.0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];
const PM10_BP = [
  [0, 54, 0, 50],
  [55, 154, 51, 100],
  [155, 254, 101, 150],
  [255, 354, 151, 200],
  [355, 424, 201, 300],
  [425, 604, 301, 500],
];

function aqiFrom(conc, bps) {
  if (!Number.isFinite(conc) || conc < 0) return NaN;
  for (const [cl, ch, il, ih] of bps) {
    if (conc <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(conc, cl) - cl) + il);
  }
  return 500;
}

/** US AQI (0–500) from PM2.5 µg/m³ (truncated to 0.1 per EPA convention). */
export function aqiPm25(c) {
  return aqiFrom(Number.isFinite(c) ? Math.floor(c * 10) / 10 : NaN, PM25_BP);
}
/** US AQI (0–500) from PM10 µg/m³ (truncated to integer per EPA convention). */
export function aqiPm10(c) {
  return aqiFrom(Number.isFinite(c) ? Math.floor(c) : NaN, PM10_BP);
}

export function aqiCategory(aqi) {
  if (!Number.isFinite(aqi)) return null;
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

// WHO 2021 global air-quality guidelines, 24-hour means (µg/m³).
export const WHO_24H = { pm25: 15, pm10: 45 };

// ── Biological / allergen exposure heuristics ──────────────────────────────

/** Sorted-ascending (oldest→newest) readings with finite humidity/temp. */
function chronological(history) {
  return (Array.isArray(history) ? history : [])
    .map((h) => ({
      t: num(h?.receivedAt),
      rh: num(h?.humidity),
      tc: tempCOf(h),
    }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
}

export function tempCOf(s) {
  let c = num(s?.temperature);
  if (!Number.isFinite(c)) c = num(s?.tempC);
  if (!Number.isFinite(c)) {
    const f = num(s?.tempF);
    if (Number.isFinite(f)) c = ((f - 32) * 5) / 9;
  }
  return c;
}

/**
 * Hours spent at/above an RH threshold within `windowH`, integrating the gap
 * between consecutive samples (each gap capped at 30 min so a data outage is
 * not counted as "damp the whole time").
 */
export function hoursAtOrAboveRh(history, threshold, windowH, now = Date.now()) {
  const rows = chronological(history).filter((r) => now - r.t <= windowH * MS_H);
  let hours = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!Number.isFinite(rows[i].rh) || rows[i].rh < threshold) continue;
    const next = rows[i + 1];
    const gap = next ? Math.min(next.t - rows[i].t, 30 * 60 * 1000) : 10 * 60 * 1000;
    hours += gap / MS_H;
  }
  return hours;
}

const band = (v, edges, labels) => labels[edges.findIndex((e) => v < e) === -1 ? labels.length - 1 : edges.findIndex((e) => v < e)];

/**
 * Mold-growth exposure (0–100). Mold needs sustained high humidity: ~60%+ RH
 * slowly, 70%+ much faster. Hours at ≥60% count once, hours at ≥70% count
 * again (so 70%+ weighs double), over the last 72 h; 36 weighted-hours = 100.
 * A very damp reading right now sets a floor so a first spike is not hidden.
 */
export function moldRisk(history, current, now = Date.now()) {
  const h60 = hoursAtOrAboveRh(history, 60, 72, now);
  const h70 = hoursAtOrAboveRh(history, 70, 72, now);
  let pct = clamp(((h60 + h70) / 36) * 100, 0, 100);
  const rh = num(current?.humidity);
  if (Number.isFinite(rh)) pct = Math.max(pct, interp(rh, [[65, 0], [75, 35], [85, 60]]));
  pct = Math.round(pct);
  return {
    pct,
    category: band(pct, [25, 50, 75], ["Low", "Moderate", "High", "Severe"]),
    hoursRh60: Math.round(h60 * 10) / 10,
    hoursRh70: Math.round(h70 * 10) / 10,
    windowHours: 72,
  };
}

/**
 * Dust-mite habitat index (0–100). Mites thrive at ≥~65% RH and 20–30 °C and
 * die back below ~50% RH, so we multiply an RH factor by a temperature factor,
 * then add weight for sustained time ≥65% RH over the last 7 days.
 */
export function dustMiteRisk(history, current, now = Date.now()) {
  const rh = num(current?.humidity);
  const tc = tempCOf(current);
  const rhF = Number.isFinite(rh) ? interp(rh, [[45, 0], [50, 0.1], [65, 0.75], [75, 1]]) : 0;
  const tF = Number.isFinite(tc) ? interp(tc, [[10, 0], [18, 0.6], [22, 1], [28, 1], [32, 0.6], [38, 0.1]]) : 0.5;
  const h65 = hoursAtOrAboveRh(history, 65, 168, now);
  const sustained = clamp(h65 / 48, 0, 1) * 30; // 48 h ≥65% over a week = +30
  const pct = Math.round(clamp(rhF * tF * 70 + sustained, 0, 100));
  return {
    pct,
    category: band(pct, [25, 50, 75], ["Low", "Moderate", "High", "Severe"]),
    hoursRh65: Math.round(h65 * 10) / 10,
    windowHours: 168,
  };
}

/** Dry-air irritant load (0–100): eyes/throat/skin, static, longer virus survival. */
export function dryAirRisk(current) {
  const rh = num(current?.humidity);
  if (!Number.isFinite(rh)) return { pct: NaN, category: null };
  const pct = Math.round(clamp(((30 - rh) / 15) * 100, 0, 100));
  return { pct, category: band(pct, [1, 35, 70], ["None", "Mild", "Moderate", "High"]) };
}

// ── Pet / dander allergen exposure (ESTIMATE) ──────────────────────────────

// Index of the "Pet/Litter" class in the firmware's 20-class odor array.
export const OD_PET_INDEX = 16;

/**
 * Estimated airborne pet-allergen (cat Fel d 1, dog Can f 1, and similar
 * dander-carried proteins) exposure, 0–100.
 *
 * IMPORTANT — this is a PROXY, not a measurement. No sensor that fits this
 * device can quantify Fel d 1; real values need lab/ELISA dust or air tests.
 * Inputs (each used only when the device actually reports it):
 *   - Pet/Litter odor class from the BME688 smell model (pets/litter present)
 *   - Coarse particulate (PM10 − PM2.5): dander and skin flakes live mostly in
 *     the 2.5–10 µm range, and activity kicks them back into the air
 *   - Stale air (CO2): poor ventilation lets airborne allergen accumulate
 * Without a particulate sensor confidence is "Low"; with one it is "Medium".
 */
export function petAllergenIndex(s, { co2, particulate } = {}) {
  const odors = Array.isArray(s?.odors) ? s.odors : [];
  const petOdor = num(odors[OD_PET_INDEX]);
  const pm25 = particulate?.pm25;
  const pm10 = particulate?.pm10;
  const coarse = Number.isFinite(pm25) && Number.isFinite(pm10) ? Math.max(0, pm10 - pm25) : NaN;

  const parts = [];
  if (Number.isFinite(petOdor)) {
    parts.push({ key: "petOdor", label: "Pet / litter odor", weight: 0.45, score: clamp(petOdor, 0, 100), detail: `smell-model pet score ${Math.round(petOdor)}` });
  }
  if (Number.isFinite(coarse)) {
    parts.push({ key: "coarse", label: "Coarse particulate (dander range)", weight: 0.4, score: interp(coarse, [[0, 0], [5, 20], [15, 60], [30, 100]]), detail: `PM10 − PM2.5 = ${coarse.toFixed(1)} µg/m³` });
  }
  if (Number.isFinite(co2)) {
    parts.push({ key: "stale", label: "Stale air (accumulation)", weight: 0.15, score: interp(co2, [[600, 0], [1000, 40], [1500, 80], [2200, 100]]), detail: `CO₂ ${Math.round(co2)} ppm` });
  }
  if (!parts.length) {
    return { index: null, level: null, confidence: "none", basis: [], measuredDirectly: false, note: "No pet-related signals reported yet." };
  }
  const wSum = parts.reduce((a, p) => a + p.weight, 0);
  const index = Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0) / wSum);
  const confidence = Number.isFinite(coarse) && Number.isFinite(petOdor) ? "medium" : Number.isFinite(coarse) || Number.isFinite(petOdor) ? "low" : "very low";
  return {
    index,
    level: band(index, [25, 50, 75], ["Low", "Moderate", "High", "Very high"]),
    confidence,
    basis: parts.map(({ key, label, score, detail }) => ({ key, label, score: Math.round(score), detail })),
    measuredDirectly: false,
    note: "Estimate from odor, particulate and ventilation signals. Cat/dog allergen proteins cannot be measured by this device; use a lab or ELISA test for actual Fel d 1 levels.",
  };
}

/** Plain-language, non-medical guidance for people visiting the home. */
export function visitorSummary(m) {
  const pet = m.petAllergen;
  const lines = [];
  if (pet?.level) {
    const tail = pet.level === "Low" ? "Pet-allergen exposure looks low right now." : pet.level === "Moderate" ? "Some pet-allergen exposure is likely, especially if you are sensitive to cats or dogs." : "Pet-allergen exposure is likely high; allergic visitors may want to take their usual precautions or ask to open a window.";
    lines.push(`${tail} (estimate, ${pet.confidence} confidence)`);
  }
  const mite = m.biological?.dustMite;
  if (mite && mite.pct >= 50) lines.push("Humid conditions favor dust mites.");
  const mold = m.biological?.mold;
  if (mold && mold.pct >= 50) lines.push("Recent dampness raises mold risk.");
  const pol = m.pollen;
  if (pol?.ok) {
    const worst = [...(pol.types || []), ...(pol.plants || [])].find((x) => (x.value ?? 0) >= 3 || x.category === "High" || x.category === "Very high");
    if (worst) lines.push(`Outdoor ${worst.name} pollen is elevated today.`);
  }
  if (m.particulate?.measured && m.particulate.aqi >= 101) lines.push(`Indoor particulate is ${m.particulate.category?.toLowerCase()}.`);
  const score = m.score?.value;
  return {
    airScore: score ?? null,
    grade: m.score?.grade || "No data",
    headline: score === null || score === undefined ? "Air data not available yet." : score >= 70 ? "Air in this home is in good shape." : score >= 50 ? "Air quality is fair." : "Air quality is currently poor.",
    notes: lines,
    petAllergen: pet?.level ? { level: pet.level, index: pet.index, confidence: pet.confidence } : null,
    disclaimer: "Estimates from home sensors and outdoor feeds. Not a medical device; allergen proteins are not measured directly.",
  };
}

// ── Gases ──────────────────────────────────────────────────────────────────

/** Formaldehyde category from ppb (typical guidance values). */
export function hchoCategory(ppb) {
  if (!Number.isFinite(ppb)) return null;
  if (ppb <= 16) return "Low";
  if (ppb <= 27) return "Acceptable";
  if (ppb <= 81) return "Elevated";
  return "High";
}

export function co2Category(ppm) {
  if (!Number.isFinite(ppm)) return null;
  if (ppm < 800) return "Fresh";
  if (ppm < 1000) return "Fine";
  if (ppm < 1400) return "Stuffy";
  return "Poor ventilation";
}

// ── Sub-scores (0–100, higher = healthier) ─────────────────────────────────

const SCORE = {
  pmAqi: [[0, 100], [50, 85], [100, 60], [150, 35], [200, 15], [300, 0]],
  iaq: [[0, 100], [50, 100], [100, 80], [150, 55], [200, 35], [300, 10], [500, 0]],
  co2: [[400, 100], [600, 100], [800, 90], [1000, 75], [1400, 45], [2000, 15], [3000, 0]],
  hcho: [[0, 100], [16, 100], [27, 80], [81, 40], [200, 0]],
  tempC: [[10, 0], [16, 55], [20, 100], [24, 100], [28, 55], [34, 0]],
};

export function gradeFor(score) {
  if (!Number.isFinite(score)) return "No data";
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 50) return "Fair";
  if (score >= 30) return "Poor";
  return "Hazardous";
}

/**
 * Everything the Home dashboard needs from the latest snapshot + history.
 * @param {object} latest    most recent snapshot (any field convention)
 * @param {object[]} history snapshots, newest-first (as getHistory returns)
 * @param {{outdoor?:object, now?:number}} [opts]
 */
export function buildHomeMetrics(latest, history, opts = {}) {
  const now = opts.now ?? Date.now();
  const s = latest || {};

  const tempC = tempCOf(s);
  const humidity = num(s.humidity);
  const pressHpa = num(s.pressHpa ?? s.pressure);
  const iaq = num(s.iaq);
  const bvoc = num(s.voc);
  const gasR = num(s.gasR ?? s.gas_resistance);

  // ── optional add-on sensors ───────────────────────────────────────────
  const pm1 = num(s.pm1);
  const pm25 = num(s.pm25);
  const pm4 = num(s.pm4);
  const pm10 = num(s.pm10);
  const co2True = num(s.co2True);
  const co2Est = num(s.co2);
  const co2 = Number.isFinite(co2True) ? co2True : co2Est;
  const co2Source = Number.isFinite(co2True) ? "sensor" : Number.isFinite(co2Est) ? "estimated" : "missing";
  const hcho = num(s.hcho);
  const vocIndex = num(s.vocIndex);
  const noxIndex = num(s.noxIndex);

  const havePm = Number.isFinite(pm25) || Number.isFinite(pm10);
  const aqi25 = aqiPm25(pm25);
  const aqi10 = aqiPm10(pm10);
  const worstAqi = Math.max(
    Number.isFinite(aqi25) ? aqi25 : -1,
    Number.isFinite(aqi10) ? aqi10 : -1
  );

  const particulate = {
    measured: havePm,
    pm1: Number.isFinite(pm1) ? pm1 : null,
    pm25: Number.isFinite(pm25) ? pm25 : null,
    pm4: Number.isFinite(pm4) ? pm4 : null,
    pm10: Number.isFinite(pm10) ? pm10 : null,
    aqiPm25: Number.isFinite(aqi25) ? aqi25 : null,
    aqiPm10: Number.isFinite(aqi10) ? aqi10 : null,
    aqi: worstAqi >= 0 ? worstAqi : null,
    category: worstAqi >= 0 ? aqiCategory(worstAqi) : null,
    whoRatio: {
      pm25: Number.isFinite(pm25) ? Math.round((pm25 / WHO_24H.pm25) * 100) / 100 : null,
      pm10: Number.isFinite(pm10) ? Math.round((pm10 / WHO_24H.pm10) * 100) / 100 : null,
    },
  };

  // ── biological ─────────────────────────────────────────────────────────
  const mold = moldRisk(history, s, now);
  const dustMite = dustMiteRisk(history, s, now);
  const dryAir = dryAirRisk(s);

  // ── climate ────────────────────────────────────────────────────────────
  const dewC = dewPointC(tempC, humidity);
  const climate = {
    tempC: Number.isFinite(tempC) ? Math.round(tempC * 10) / 10 : null,
    tempF: Number.isFinite(tempC) ? Math.round((tempC * 9 / 5 + 32) * 10) / 10 : null,
    humidity: Number.isFinite(humidity) ? Math.round(humidity * 10) / 10 : null,
    dewPointC: Number.isFinite(dewC) ? Math.round(dewC * 10) / 10 : null,
    absHumidity: Number.isFinite(absoluteHumidity(tempC, humidity))
      ? Math.round(absoluteHumidity(tempC, humidity) * 10) / 10
      : null,
    pressHpa: Number.isFinite(pressHpa) ? Math.round(pressHpa * 10) / 10 : null,
    comfort: comfortLabel(tempC, humidity),
  };

  const gases = {
    iaq: Number.isFinite(iaq) ? iaq : null,
    iaqSource: Number.isFinite(iaq) ? "estimated" : "missing",
    bvoc: Number.isFinite(bvoc) ? bvoc : null,
    gasR: Number.isFinite(gasR) ? gasR : null,
    co2: Number.isFinite(co2) ? Math.round(co2) : null,
    co2Source,
    co2Category: co2Category(co2),
    hcho: Number.isFinite(hcho) ? hcho : null,
    hchoCategory: hchoCategory(hcho),
    vocIndex: Number.isFinite(vocIndex) ? vocIndex : null,
    noxIndex: Number.isFinite(noxIndex) ? noxIndex : null,
  };

  // ── composite score ────────────────────────────────────────────────────
  const comps = [];
  const add = (key, label, weight, value, source, detail) =>
    comps.push({ key, label, weight, score: Number.isFinite(value) ? Math.round(value) : null, source, detail });

  add("particulate", "Particulate", 30, worstAqi >= 0 ? interp(worstAqi, SCORE.pmAqi) : NaN,
      havePm ? "sensor" : "missing", havePm ? `AQI ${worstAqi} (${aqiCategory(worstAqi)})` : "No particulate sensor");
  add("voc", "VOC / odor", 20, Number.isFinite(iaq) ? interp(iaq, SCORE.iaq) : NaN,
      Number.isFinite(iaq) ? "estimated" : "missing", Number.isFinite(iaq) ? `IAQ ${Math.round(iaq)}` : "No IAQ");
  add("ventilation", "Ventilation (CO₂)", 15, Number.isFinite(co2) ? interp(co2, SCORE.co2) : NaN,
      co2Source, Number.isFinite(co2) ? `${Math.round(co2)} ppm` : "No CO₂");
  const bioWorst = Math.max(mold.pct, dustMite.pct, Number.isFinite(dryAir.pct) ? dryAir.pct * 0.7 : 0);
  add("biological", "Mold / mites / dryness", 20, Number.isFinite(humidity) ? 100 - bioWorst : NaN,
      Number.isFinite(humidity) ? "estimated" : "missing", `mold ${mold.pct}%, mites ${dustMite.pct}%`);
  add("hcho", "Formaldehyde", 10, Number.isFinite(hcho) ? interp(hcho, SCORE.hcho) : NaN,
      Number.isFinite(hcho) ? "sensor" : "missing", Number.isFinite(hcho) ? `${hcho} ppb` : "No HCHO sensor");
  add("comfort", "Thermal comfort", 5, Number.isFinite(tempC) ? interp(tempC, SCORE.tempC) : NaN,
      Number.isFinite(tempC) ? "sensor" : "missing", climate.comfort);

  const live = comps.filter((c) => c.score !== null);
  const wSum = live.reduce((a, c) => a + c.weight, 0);
  const value = wSum ? Math.round(live.reduce((a, c) => a + c.score * c.weight, 0) / wSum) : null;
  const drivers = [...live]
    .filter((c) => c.score < 75)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => ({ key: c.key, label: c.label, score: c.score, detail: c.detail }));

  // ── outdoor + indoor/outdoor ───────────────────────────────────────────
  const outdoor = buildOutdoor(s, opts.outdoor);
  const indoorOutdoor = {
    pm25Ratio:
      Number.isFinite(pm25) && Number.isFinite(outdoor.pm25) && outdoor.pm25 > 0
        ? Math.round((pm25 / outdoor.pm25) * 100) / 100
        : null,
    absHumidityDelta:
      Number.isFinite(outdoor.absHumidity) && climate.absHumidity !== null
        ? Math.round((climate.absHumidity - outdoor.absHumidity) * 10) / 10
        : null,
  };

  const petAllergen = petAllergenIndex(s, { co2, particulate: { pm25, pm10 } });
  const result = {
    score: { value, grade: gradeFor(value ?? NaN), components: comps, drivers },
    particulate,
    gases,
    climate,
    biological: { mold, dustMite, dryAir },
    petAllergen,
    outdoor,
    indoorOutdoor,
    coverage: buildCoverage({ havePm, co2Source, hcho, vocIndex, noxIndex, iaq, humidity, outdoor, pollen: opts.pollen, petAllergen }),
  };
  result.visitor = visitorSummary({ ...result, pollen: opts.pollen });
  return result;
}

function comfortLabel(tempC, rh) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh)) return "Unknown";
  if (rh < 30) return "Dry";
  if (rh > 65) return "Humid";
  if (tempC > 26) return "Warm";
  if (tempC < 18) return "Cool";
  return "Comfortable";
}

/** Merge pollutants the device already posts with optional Open-Meteo data. */
function buildOutdoor(s, extra) {
  const pm25 = num(extra?.pm25 ?? s.outdoorPm25);
  const pm10 = num(extra?.pm10 ?? s.outdoorPm10);
  const o = {
    source: extra ? "open-meteo" : Number.isFinite(num(s.outdoorPm25)) ? "device (OpenWeather)" : "none",
    pm25: Number.isFinite(pm25) ? pm25 : null,
    pm10: Number.isFinite(pm10) ? pm10 : null,
    usAqi: Number.isFinite(num(extra?.usAqi)) ? num(extra.usAqi) : Number.isFinite(pm25) ? aqiPm25(pm25) : null,
    o3: num(extra?.o3 ?? s.outdoorO3, null),
    no2: num(extra?.no2 ?? s.outdoorNo2, null),
    so2: num(extra?.so2 ?? s.outdoorSo2, null),
    co: num(extra?.co ?? s.outdoorCo, null),
    dust: num(extra?.dust, null),
    uvIndex: num(extra?.uvIndex, null),
    tempC: num(extra?.tempC, null),
    humidity: num(extra?.humidity, null),
    dewPointC: num(extra?.dewPointC, null),
    absHumidity: NaN,
    rainMm: num(extra?.rainMm, null),
    advisory: typeof s.aqiAdvisory === "string" ? s.aqiAdvisory : "",
  };
  o.absHumidity = absoluteHumidity(o.tempC ?? NaN, o.humidity ?? NaN);
  if (!Number.isFinite(o.absHumidity)) o.absHumidity = null;
  return o;
}

/** What is measured vs estimated vs unavailable — shown on the dashboard. */
function buildCoverage({ havePm, co2Source, hcho, vocIndex, noxIndex, iaq, humidity, outdoor, pollen, petAllergen }) {
  const row = (metric, source, detail) => ({ metric, source, detail });
  return [
    row("Temperature / humidity / pressure", Number.isFinite(humidity) ? "sensor" : "missing", "BME688"),
    row("IAQ / VOC / odor", Number.isFinite(iaq) ? "estimated" : "missing", "BME688 gas resistance + BSEC model"),
    row("CO₂", co2Source, co2Source === "sensor" ? "Dedicated CO₂ sensor" : co2Source === "estimated" ? "BSEC CO₂-equivalent (a model estimate)" : "Not reported"),
    row("Indoor particulate (PM1/2.5/4/10)", havePm ? "sensor" : "missing", havePm ? "Add-on particulate sensor" : "Needs a PM sensor (e.g. Sensirion SEN5x, PMS5003)"),
    row("Formaldehyde (HCHO)", Number.isFinite(hcho) ? "sensor" : "missing", Number.isFinite(hcho) ? "Add-on sensor" : "Needs an HCHO sensor (e.g. Sensirion SFA30)"),
    row("VOC / NOx index", Number.isFinite(vocIndex) || Number.isFinite(noxIndex) ? "sensor" : "missing", "Sensirion index (optional)"),
    row("Mold / dust-mite / dry-air risk", Number.isFinite(humidity) ? "estimated" : "missing", "Heuristic from humidity + temperature history"),
    row("Outdoor particulate & gases", outdoor.source === "none" ? "missing" : "outdoor-api", outdoor.source),
    row("Cat / dog allergen (Fel d 1, Can f 1)", petAllergen?.index !== null && petAllergen?.index !== undefined ? "estimated" : "missing", "Proxy only (odor + coarse particulate + ventilation); direct measurement needs a lab/ELISA test"),
    row("Pollen", pollen?.ok ? "outdoor-api" : "missing", pollen?.ok ? pollen.source : pollen?.reason || "Pollen feed not available"),
  ];
}

/**
 * Home-mode alert conditions. Returns breach objects in the same shape as
 * thresholds.evaluateBreaches so they flow through the existing SMS pipeline.
 * SMS text stays GSM-7 (no special symbols).
 */
export function evaluateHomeBreaches(reading, T = {}) {
  const out = [];
  const r = reading || {};
  const pm25Limit = Number.isFinite(T.PM25_HIGH) ? T.PM25_HIGH : 35;
  if (Number.isFinite(r.pm25) && r.pm25 >= pm25Limit) {
    out.push({
      key: "pm25",
      level: r.pm25 >= pm25Limit * 1.6 ? "crit" : "warn",
      label: "High PM2.5",
      message: `PM2.5 ${r.pm25.toFixed(0)} ug/m3 (limit ${pm25Limit}) - smoke, cooking or dust in the home; run the purifier / ventilate if outdoor air is cleaner.`,
    });
  }
  if (Number.isFinite(r.hcho) && r.hcho >= 81) {
    out.push({
      key: "hcho",
      level: "crit",
      label: "High formaldehyde",
      message: `Formaldehyde ${r.hcho.toFixed(0)} ppb - elevated; ventilate and look for new furniture, flooring or paint.`,
    });
  }
  if (Number.isFinite(r.humidity) && r.humidity < 25) {
    out.push({
      key: "dry",
      level: "warn",
      label: "Very dry air",
      message: `Humidity ${r.humidity.toFixed(0)}% - dry air irritates eyes and airways; consider a humidifier.`,
    });
  }
  return out;
}
