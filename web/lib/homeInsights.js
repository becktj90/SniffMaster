/**
 * homeInsights.js — what a person at home actually wants to know:
 *   1. Does this room smell bad right now, how bad, since when, and why?
 *   2. Given MY sensitivities (cat, dog, pollen, dust mite, mold, smoke), how
 *      risky is it to be here, and what should I do about it?
 *
 * Pure functions, no I/O. Everything returned carries its evidence and a
 * confidence so the UI never states a guess as fact.
 *
 * Smell detection method
 * ----------------------
 * A heated metal-oxide gas sensor reports resistance, which DROPS when
 * reducing gases (VOCs, sulfur compounds, solvents, smoke) are present — but
 * it also drops when the air is humid. Reading raw resistance against a fixed
 * threshold therefore confuses a steamy shower with a bad smell. Instead we:
 *   - take ln(gas resistance) over the last day of this room's own history,
 *   - regress it on absolute humidity to remove the humidity effect,
 *   - define "clean air" as the 75th percentile of the residuals (the room's
 *     own good air, not a factory number), and
 *   - express the current reading as how far below clean it sits, in units of
 *     ln-resistance (0.69 = resistance halved).
 * A smell must persist across several samples to count, so one noisy sample
 * does not raise an alarm. The label (cooking, litter, sulfur...) comes from
 * the on-device odor classifier and is only trusted when it is confident.
 */

import { num, clamp, interp, absoluteHumidity, tempCOf } from "./homeAir.js";

const MIN = 60 * 1000;

// Must match odorNames[] in firmware/src/main.cpp.
export const ODOR_NAMES = [
  "Flatulence", "Musty", "Cigarette smoke", "Alcohol", "Cannabis", "Cleaning products",
  "Gasoline", "Smoke", "Cooking", "Coffee", "Garbage", "Body odor",
  "Perfume", "Laundry", "Sulfur / rotten egg", "Solvent", "Pet / litter", "Sour food",
  "Burnt / oil", "Citrus",
];
// Pleasant or benign classes: detected, but not "smells bad".
const BENIGN = new Set([9, 12, 13, 19]); // coffee, perfume, laundry, citrus
// Classes that can matter for safety or health beyond comfort.
const SAFETY = {
  6: "Gasoline vapor — find the source and ventilate.",
  7: "Smoke — check for something burning.",
  14: "Sulfur smell — check drains, the water heater and gas appliances. If you smell gas, leave and call your utility.",
  15: "Solvent vapor — ventilate and keep the product sealed.",
  18: "Burnt oil or food — check the stove and oven.",
};
const SUGGEST = {
  0: "Open a window or run the bath fan for 10 minutes.",
  1: "Musty air usually means damp: check for leaks, run a dehumidifier, and look behind furniture.",
  2: "Ventilate. Cigarette residue also clings to fabric and keeps off-gassing.",
  3: "Ventilate; check for a spill.",
  4: "Ventilate.",
  5: "Ventilate while cleaning products dry, and avoid mixing them.",
  8: "Run the range hood and open a window.",
  10: "Take the trash out and check the bin and drains.",
  11: "Air the room and wash recent bedding or clothes.",
  16: "Scoop the litter box and open a window.",
  17: "Look for spoiled food and check the fridge and bin.",
};

// ── Smell ──────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Ordinary least squares y = a + b x. Returns null when x has no spread. */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx < 1e-9) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, mx };
}

function gasRows(history, now) {
  const rows = [];
  for (const h of Array.isArray(history) ? history : []) {
    const t = num(h?.receivedAt ?? h?.t);
    const g = num(h?.gasR ?? h?.gas_resistance);
    if (!Number.isFinite(t) || !Number.isFinite(g) || g <= 0 || t > now) continue;
    if (now - t > 26 * 3600 * 1000) continue;
    const ah = absoluteHumidity(tempCOf(h), num(h?.humidity));
    rows.push({ t, lg: Math.log(g), ah, odors: Array.isArray(h?.odors) ? h.odors : null });
  }
  return rows.sort((a, b) => a.t - b.t);
}

/** Humidity-corrected distance below this room's clean-air baseline. */
export function gasDeficit(history, latest, now = Date.now()) {
  const rows = gasRows(history, now);
  const g = num(latest?.gasR ?? latest?.gas_resistance);
  const curAh = absoluteHumidity(tempCOf(latest), num(latest?.humidity));
  if (!Number.isFinite(g) || g <= 0) return null;
  const curLg = Math.log(g);

  const withAh = rows.filter((r) => Number.isFinite(r.ah));
  // Need real history before a baseline means anything.
  if (rows.length < 30) return { deficit: null, reason: "learning", samples: rows.length, spanH: 0 };
  const spanH = (now - rows[0].t) / (3600 * 1000);

  let fit = withAh.length >= 30 ? ols(withAh.map((r) => r.ah), withAh.map((r) => r.lg)) : null;
  // A humidity slope that rises with moisture is non-physical for this sensor
  // (it is almost always a cooking/shower event leaking into the fit): drop it.
  if (fit && fit.b > 0) fit = null;
  const resid = (r) => (fit && Number.isFinite(r.ah) ? r.lg - (fit.a + fit.b * r.ah) : r.lg);
  const all = rows.map(resid).sort((a, b) => a - b);
  const clean = percentile(all, 0.75);
  const spread = Math.max(0.05, percentile(all.map((v) => Math.abs(v - percentile(all, 0.5))).sort((a, b) => a - b), 0.5) * 1.4826);
  const curResid = fit && Number.isFinite(curAh) ? curLg - (fit.a + fit.b * curAh) : curLg;
  return {
    deficit: clean - curResid,
    clean,
    spread,
    humidityCorrected: !!fit,
    samples: rows.length,
    spanH,
    recent: rows.slice(-60).map((r) => ({ t: r.t, d: clean - resid(r), odors: r.odors })),
    series: rows.filter((_, i) => i % 5 === 0).map((r) => ({ t: r.t, d: clean - resid(r) })),
  };
}

const LEVELS = [
  { max: 0.12, label: "Fresh", tone: "good" },
  { max: 0.3, label: "Slight odor", tone: "fair" },
  { max: 0.6, label: "Noticeable smell", tone: "poor" },
  { max: Infinity, label: "Strong smell", tone: "bad" },
];

function levelFor(d) {
  return LEVELS.find((l) => d < l.max);
}

/**
 * Is the room smelling bad, how bad, since when, and what is it?
 * @param {object} latest   latest snapshot (gasR, humidity, odors, iaq, iaqAcc)
 * @param {object[]} history snapshots (any order)
 */
export function analyzeSmell(latest, history, { now = Date.now() } = {}) {
  const s = latest || {};
  const acc = num(s.iaqAcc);
  const gd = gasDeficit(history, s, now);

  if (!gd) return { state: "unknown", headline: "No gas reading yet.", level: null, confidence: "none" };
  if (gd.deficit === null) {
    return {
      state: "learning",
      headline: "Learning what clean air smells like in this room.",
      level: null,
      confidence: "none",
      detail: `${gd.samples} readings so far; smell detection starts after about 30.`,
    };
  }

  const dNow = gd.deficit;
  const level = levelFor(dNow);
  // Persistence: a smell is real when most of the last 5 minutes agree.
  const last5 = gd.recent.filter((r) => now - r.t <= 5 * MIN);
  const agree = last5.length ? last5.filter((r) => r.d >= 0.3).length / last5.length : dNow >= 0.3 ? 1 : 0;
  const persistent = last5.length >= 2 ? agree >= 0.6 : dNow >= 0.3;

  // Since when: walk back while the deficit stays above the "noticeable" line.
  let sinceMs = null;
  if (dNow >= 0.3) {
    let start = now;
    for (let i = gd.recent.length - 1; i >= 0; i--) {
      if (gd.recent[i].d < 0.2) break;
      start = gd.recent[i].t;
    }
    sinceMs = now - start;
  }

  // Trend over the last ~10 minutes.
  let trend = "steady";
  const early = gd.recent.filter((r) => now - r.t > 8 * MIN && now - r.t <= 25 * MIN).map((r) => r.d);
  const late = gd.recent.filter((r) => now - r.t <= 5 * MIN).map((r) => r.d);
  if (early.length && late.length) {
    const diff = late.reduce((a, v) => a + v, 0) / late.length - early.reduce((a, v) => a + v, 0) / early.length;
    trend = diff > 0.12 ? "worsening" : diff < -0.12 ? "clearing" : "steady";
  }

  // What is it? Use the on-device classifier only when confident.
  // Scores under 20 are the background band the smell page already labels
  // as noise, and the cutoff the OLED uses before it will name an odor.
  const odors = Array.isArray(s.odors) ? s.odors.map((v) => num(v, 0)) : [];
  let topOdorScore = 0;
  let cause = null;
  if (odors.length) {
    let top = 0;
    for (let i = 1; i < odors.length; i++) if (odors[i] > odors[top]) top = i;
    topOdorScore = odors[top];
    const second = odors.reduce((m, v, i) => (i !== top && v > m ? v : m), 0);
    if (odors[top] >= 45 && odors[top] - second >= 10) {
      cause = { index: top, name: ODOR_NAMES[top] || `class ${top}`, score: Math.round(odors[top]), benign: BENIGN.has(top) };
    }
  }

  // Confidence: calibrated sensor, enough history, humidity-corrected baseline.
  let confidence = "high";
  if (Number.isFinite(acc) && acc < 2) confidence = "low";
  else if (gd.spanH < 6 || !gd.humidityCorrected) confidence = "medium";
  if (gd.spanH < 2) confidence = "low";

  const rawGasChange = persistent && dNow >= 0.3;
  // A gas-resistance drop says the air changed. It cannot name a smell.
  // When the classifier is present and every channel is still background,
  // keep that distinction instead of asserting "Strong smell" or alerting.
  const unclassifiedGasChange = rawGasChange && odors.length > 0 && topOdorScore < 20;
  // Accuracy below 2 is not a trusted odor call, even if one class is above
  // background. Time spent in a still room does not promote that accuracy.
  const lowAccuracy = Number.isFinite(acc) && acc < 2;
  const lowAccuracyGasShift = rawGasChange && lowAccuracy;
  const trustedCause = !lowAccuracy;
  const bad = rawGasChange && !unclassifiedGasChange && !lowAccuracyGasShift && !(cause && cause.benign && trustedCause && dNow < 0.6);
  const smellsBad = bad;
  const safety = trustedCause && cause && SAFETY[cause.index] ? SAFETY[cause.index] : null;

  let headline;
  if (lowAccuracyGasShift && !unclassifiedGasChange) headline = "Gas signal changed, but BSEC accuracy is still too low to call it a smell.";
  else if (unclassifiedGasChange) headline = "Gas signal changed, but no odor class is confirmed.";
  else if (!bad) headline = dNow >= 0.12 ? "Air is slightly off but not smelly." : "Air smells fresh.";
  else if (cause && !cause.benign) headline = `${level.label}: probably ${cause.name.toLowerCase()}.`;
  else headline = `${level.label}.`;

  const action = bad ? (safety || (cause && SUGGEST[cause.index]) || "Open a window or run a fan; check for a spill, trash or damp spot.") : null;
  const gasShift = unclassifiedGasChange || lowAccuracyGasShift;

  return {
    state: smellsBad ? "bad" : gasShift ? "unclassified" : "ok",
    smellsBad,
    unclassifiedGasChange: gasShift,
    level: gasShift ? (unclassifiedGasChange ? "Unclassified gas change" : "Low-accuracy gas change") : level.label,
    tone: gasShift ? "fair" : bad ? level.tone : dNow >= 0.12 ? "fair" : "good",
    headline,
    action,
    safety: !!safety,
    trend: rawGasChange ? trend : null,
    sinceMinutes: sinceMs === null ? null : Math.round(sinceMs / MIN),
    cause: lowAccuracyGasShift ? null : cause,
    confidence,
    deficit: Math.round(dNow * 100) / 100,
    detail:
      `Gas resistance is ${dNow >= 0 ? Math.round((1 - Math.exp(-dNow)) * 100) : 0}% below this room's own clean-air level` +
      (gd.humidityCorrected ? ", corrected for humidity" : "") +
      `, from ${gd.samples} readings over ${Math.round(gd.spanH)}h.` +
      (unclassifiedGasChange ? ` The odor classifier is still below background (top score ${Math.round(topOdorScore)}/100).` : ""),
  };
}

// ── Sensitivities ──────────────────────────────────────────────────────────

export const TRIGGERS = ["cat", "dog", "pollen", "treePollen", "grassPollen", "weedPollen", "dustMite", "mold", "dust", "voc", "dryAir", "smoke"];

export function parseTriggers(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(",");
  return [...new Set(raw.map((x) => String(x).trim()).filter((x) => TRIGGERS.includes(x)))];
}

// ── Per-trigger severity ───────────────────────────────────────────────────
// How strongly someone reacts to a trigger, on top of the measured
// exposure. Mild softens the outlook by one level, severe sharpens it by
// one; moderate leaves the measured level alone. Stored per-device in
// localStorage (sm-trigger-severity) and sent with the triggers query
// param as "cat:severe,pollen:mild" — the server applies it when it builds
// the outlook, so the headline, the per-trigger level and the action all
// move together.
export const SEVERITIES = ["mild", "moderate", "severe"];

export function parseSeverities(input) {
  const out = {};
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, level] of Object.entries(input)) {
      if (TRIGGERS.includes(key) && SEVERITIES.includes(level)) out[key] = level;
    }
    return out;
  }
  const raw = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((x) => String(x).trim())
        .filter(Boolean);
  for (const pair of raw) {
    const [key, level] = String(pair).split(":").map((x) => x.trim());
    if (TRIGGERS.includes(key) && SEVERITIES.includes(level)) out[key] = level;
  }
  return out;
}

/** Canonical "key:level" string (non-moderate entries only) for cache keys. */
export function canonicalSeverities(input) {
  const sev = parseSeverities(input);
  return Object.keys(sev)
    .sort()
    .filter((k) => sev[k] !== "moderate")
    .map((k) => `${k}:${sev[k]}`)
    .join(",");
}

/** Shift a 0–4 exposure rank by the user's severity for that trigger. */
export function applySeverity(rank, severity) {
  if (severity === "severe") return Math.min(4, rank + 1);
  if (severity === "mild") return Math.max(0, rank - 1);
  return rank;
}

const rank = { None: 0, Low: 1, Moderate: 2, High: 3, "Very high": 4 };
const byRank = (r) => Object.keys(rank).find((k) => rank[k] === r) || "None";

function pollenScore(it) {
  const v = num(it.value, NaN);
  const cat = it.category;
  return Number.isFinite(v) ? v : cat ? ({ "Very low": 1, Low: 2, Moderate: 3, High: 4, "Very high": 5 }[cat] ?? 0) : 0;
}

function worstOf(items) {
  let worst = null;
  for (const it of items) {
    const score = pollenScore(it);
    if (!worst || score > worst.score) worst = { name: it.name, score, category: it.category };
  }
  return worst;
}

function worstPollen(pollen, prefer) {
  if (!pollen?.ok) return null;
  const items = [...(pollen.types || []), ...(pollen.plants || [])];
  if (prefer) return worstOf(items);
  return worstOf(items);
}

// Pollen by family, for the tree/grass/weed triggers. Google types carry
// GRASS/TREE/WEED codes; Open-Meteo plants carry the plant name as code
// (ALDER, BIRCH, GRASS, MUGWORT, OLIVE, RAGWEED). Unknown codes are ignored
// so a feed change degrades to "no data" instead of a wrong group.
const POLLEN_GROUPS = {
  treePollen: ["TREE", "ALDER", "BIRCH", "OLIVE"],
  grassPollen: ["GRASS"],
  weedPollen: ["WEED", "MUGWORT", "RAGWEED"],
};

function pollenByGroup(pollen, group) {
  if (!pollen?.ok) return null;
  const codes = POLLEN_GROUPS[group] || [];
  const items = [...(pollen.types || []), ...(pollen.plants || [])].filter((it) =>
    codes.includes(String(it.code || "").toUpperCase())
  );
  return worstOf(items);
}

function pollenRank(score) {
  // Universal Pollen Index 0-5: 2 Low, 3 Moderate, 4 High, 5 Very high.
  return score >= 5 ? 4 : score >= 4 ? 3 : score >= 3 ? 2 : score >= 2 ? 1 : 0;
}

/**
 * Personal outlook for someone with the given sensitivities.
 * Each trigger returns a level, the evidence, and one action. The overall
 * level is the worst applicable trigger — an allergy outlook is only as good
 * as its worst exposure.
 * @param {object} [severities] — per-trigger mild/moderate/severe; severe
 *   sharpens a trigger's level by one, mild softens it by one. The action
 *   follows the adjusted level, so a severe trigger earns advice at lower
 *   exposures and a mild one stays quiet until exposure is real.
 */
export function allergyOutlook(metrics, triggers, smell = null, severities = {}) {
  const picked = parseTriggers(triggers);
  const sev = parseSeverities(severities);
  const m = metrics || {};
  const items = [];

  const add = (key, label, r, reason, action, confidence) => {
    const severity = sev[key] || "moderate";
    const adjusted = applySeverity(r, severity);
    items.push({ key, label, level: byRank(adjusted), rank: adjusted, baseRank: r, severity, reason, action: adjusted >= 2 ? action : null, confidence });
  };

  for (const key of picked) {
    if (key === "cat" || key === "dog") {
      const pet = m.petAllergen;
      const label = key === "cat" ? "Cat allergen" : "Dog allergen";
      if (!pet || pet.index === null || pet.index === undefined) {
        add(key, label, 0, "No pet signals yet.", null, "none");
        continue;
      }
      const r = pet.index >= 75 ? 4 : pet.index >= 50 ? 3 : pet.index >= 25 ? 2 : 1;
      const lowBasis = pet.confidence !== "medium";
      add(
        key,
        label,
        r,
        `Estimated from ${pet.basis.map((b) => b.label.toLowerCase()).join(", ")}. Allergen proteins settle into dust and fabric and are not measured directly.`,
        "Run a HEPA purifier, keep pets out of the bedroom, wash bedding hot weekly, and vacuum with a HEPA filter.",
        lowBasis ? "low" : "medium"
      );
    } else if (key === "pollen") {
      const pol = m.pollen;
      const w = worstPollen(pol);
      if (!w) {
        add(key, "Pollen", 0, pol?.reason || "Pollen feed unavailable.", null, "none");
        continue;
      }
      const r = pollenRank(w.score);
      const pm = m.indoorOutdoor?.pm25Ratio;
      add(
        key,
        "Pollen",
        r,
        `Outdoors: ${w.name} is ${String(w.category || "").toLowerCase() || "present"}. Indoor pollen is not measured — this is the outdoor level that comes in on windows, clothes and pets.`,
        "Keep windows shut, run the AC on recirculate, shower and change after being outside, and run a HEPA purifier." + (pm != null && pm > 1 ? "" : ""),
        "medium"
      );
    } else if (key === "treePollen" || key === "grassPollen" || key === "weedPollen") {
      const groupName = key === "treePollen" ? "Tree pollen" : key === "grassPollen" ? "Grass pollen" : "Weed pollen";
      const pol = m.pollen;
      const w = pollenByGroup(pol, key);
      if (!w) {
        add(key, groupName, 0, pol?.reason || "Pollen feed unavailable.", null, "none");
        continue;
      }
      const r = pollenRank(w.score);
      add(
        key,
        groupName,
        r,
        `Outdoors: ${w.name} is ${String(w.category || "").toLowerCase() || "present"}. Indoor pollen is not measured — this is the outdoor level that comes in on windows, clothes and pets.`,
        "Keep windows shut, run the AC on recirculate, shower and change after being outside, and run a HEPA purifier.",
        "medium"
      );
    } else if (key === "dustMite") {
      const d = m.biological?.dustMite;
      if (!d) continue;
      const r = d.pct >= 75 ? 4 : d.pct >= 50 ? 3 : d.pct >= 25 ? 2 : 1;
      add(
        key,
        "Dust mites",
        r,
        `Habitat index ${d.pct}% from humidity and temperature${d.windowComplete === false ? ` (${d.coverageHours}h of ${d.windowHours}h recorded)` : ""}. Mites need ≥65% RH.`,
        "Bring humidity below 50%, use a dehumidifier, and wash bedding at 130°F / 54°C.",
        d.windowComplete === false ? "low" : "medium"
      );
    } else if (key === "mold") {
      const d = m.biological?.mold;
      if (!d) continue;
      const r = d.pct >= 75 ? 4 : d.pct >= 50 ? 3 : d.pct >= 25 ? 2 : 1;
      const musty = smell?.cause?.index === 1 && smell?.smellsBad;
      add(
        key,
        "Mold",
        musty ? Math.max(r, 3) : r,
        `Growth exposure ${d.pct}% from ${d.hoursRh60}h at ≥60% RH in 72h${musty ? "; the room also smells musty right now" : ""}.`,
        "Dry the room below 55% RH and look for leaks, window condensation and damp corners.",
        d.windowComplete === false ? "low" : "medium"
      );
    } else if (key === "dust") {
      const pt = m.particulate;
      const pm10 = pt?.pm10;
      const out10 = m.outdoor?.pm10;
      const v = Number.isFinite(pm10) ? pm10 : Number.isFinite(out10) ? out10 : null;
      if (v === null) {
        add(key, "Dust", 0, "No particulate sensor or outdoor feed.", null, "none");
        continue;
      }
      // PM10 bands (µg/m³) track the US AQI PM10 breakpoints (55/155/255).
      const r = v >= 150 ? 4 : v >= 100 ? 3 : v >= 55 ? 2 : 1;
      add(
        key,
        "Dust",
        r,
        `${Number.isFinite(pm10) ? "Indoor" : "Outdoor"} coarse dust (PM10) ${Math.round(v)} µg/m³. Dust in the 2.5–10 µm range carries dander, skin flakes and other allergens.`,
        "Damp-dust hard surfaces, vacuum with a HEPA filter, and run a HEPA purifier.",
        Number.isFinite(pm10) ? "medium" : "low"
      );
    } else if (key === "voc") {
      const g = m.gases || {};
      const iaq = g.iaq;
      const bvoc = g.bvoc;
      const hcho = g.hcho;
      if (!Number.isFinite(iaq) && !Number.isFinite(bvoc) && !Number.isFinite(hcho)) {
        add(key, "Fragrances & chemicals", 0, "No gas readings yet.", null, "none");
        continue;
      }
      // IAQ is the VOC-driven index this dashboard already uses (150 = poor).
      let r = Number.isFinite(iaq) ? (iaq >= 150 ? 4 : iaq >= 100 ? 3 : iaq >= 50 ? 2 : 1) : 1;
      if (Number.isFinite(hcho) && hcho >= 100) r = Math.max(r, 3);
      const bits = [];
      if (Number.isFinite(bvoc)) bits.push(`VOC ${bvoc.toFixed(2)} ppm`);
      if (Number.isFinite(iaq)) bits.push(`IAQ ${Math.round(iaq)}`);
      if (Number.isFinite(hcho)) bits.push(`formaldehyde ${Math.round(hcho)} ppb`);
      add(
        key,
        "Fragrances & chemicals",
        r,
        bits.length ? bits.join("; ") + "." : "Gas readings present.",
        "Ventilate, skip sprays and plug-ins while it clears, and find the source — cleaners, candles, fresh paint or new furniture.",
        Number.isFinite(iaq) ? "medium" : "low"
      );
    } else if (key === "dryAir") {
      const d = m.biological?.dryAir;
      if (!d || !Number.isFinite(d.pct)) {
        add(key, "Dry air", 0, "No humidity reading yet.", null, "none");
        continue;
      }
      const r = d.pct >= 75 ? 4 : d.pct >= 50 ? 3 : d.pct >= 25 ? 2 : 1;
      const rh = m.climate?.humidity;
      add(
        key,
        "Dry air",
        r,
        `Dryness index ${d.pct}%${Number.isFinite(rh) ? ` at ${Math.round(rh)}% RH` : ""}. Air below ~30% RH dries airways and skin.`,
        "Run a humidifier to 40–50% RH, and keep it below 55% so mold and mites don't move in.",
        "medium"
      );
    } else if (key === "smoke") {
      const pt = m.particulate;
      const aq = m.outdoor?.usAqi;
      const smokeOdor = smell?.smellsBad && smell?.cause && [2, 7, 18].includes(smell.cause.index);
      let r = 0;
      const bits = [];
      if (pt?.measured && pt.aqi != null) {
        r = Math.max(r, pt.aqi >= 151 ? 4 : pt.aqi >= 101 ? 3 : pt.aqi >= 51 ? 2 : 1);
        bits.push(`indoor PM AQI ${pt.aqi}`);
      }
      if (Number.isFinite(aq)) {
        r = Math.max(r, aq >= 151 ? 3 : aq >= 101 ? 2 : 1);
        bits.push(`outdoor AQI ${Math.round(aq)}`);
      }
      if (smokeOdor) {
        r = Math.max(r, 3);
        bits.push(`smoke-type smell detected (${smell.cause.name.toLowerCase()})`);
      }
      add(
        key,
        "Smoke & particles",
        r,
        bits.length ? bits.join("; ") + "." : "No particulate sensor or outdoor feed.",
        "Use a HEPA purifier, keep windows shut if outdoor air is worse, and find the indoor source.",
        pt?.measured ? "high" : "low"
      );
    }
  }

  const overall = items.reduce((mx, i) => Math.max(mx, i.rank), 0);
  const top = items.filter((i) => i.rank === overall && overall >= 2).map((i) => i.label);
  return {
    triggers: picked,
    level: picked.length ? byRank(overall) : null,
    rank: overall,
    headline: !picked.length
      ? "Pick what you react to for a personal outlook."
      : overall >= 3
      ? `High risk today for ${top.join(" and ")}.`
      : overall === 2
      ? `Moderate: ${top.join(" and ")} could bother you.`
      : "Low risk for the things you react to right now.",
    items,
  };
}

// ── Windows: open or closed? ───────────────────────────────────────────────

/** One clear recommendation using indoor state, outdoor air and pollen.
 * Returns the verdict plus the readings behind it, so the dashboard can
 * show why — every reason is a real reading, toned against the same
 * thresholds the verdict uses. A missing reading simply leaves its reason
 * out; nothing is ever guessed. */
export function ventilationAdvice(metrics, smell, triggers = []) {
  const m = metrics || {};
  const wantsPollen = parseTriggers(triggers).includes("pollen");
  const pol = worstPollen(m.pollen);
  const pollenHigh = pol && pol.score >= 4;
  const aq = m.outdoor?.usAqi;
  const outdoorBad = Number.isFinite(aq) && aq >= 101;
  const co2 = m.gases?.co2;
  const iaq = m.gases?.iaq;
  const indoorStale = (co2 ?? 0) >= 1000 || smell?.smellsBad || (iaq ?? 0) >= 150;
  const ahDelta = m.indoorOutdoor?.absHumidityDelta;
  const outdoorWet = Number.isFinite(ahDelta) && ahDelta < -3 && (m.climate?.humidity ?? 0) >= 55;

  const co2Reason = () => Number.isFinite(co2)
    ? { label: "Indoor CO₂", value: `${Math.round(co2).toLocaleString("en-US")} ppm`, tone: co2 >= 1000 ? "poor" : "good", note: co2 >= 1000 ? "Stale" : "Fresh" }
    : null;
  const iaqReason = () => Number.isFinite(iaq) && iaq >= 150
    ? { label: "Indoor IAQ", value: String(Math.round(iaq)), tone: "poor", note: "Poor" }
    : null;
  const smellReason = () => smell?.smellsBad
    ? { label: "Smell indoors", value: "Detected", tone: "poor", note: "Detected" }
    : null;
  const staleReason = () => (Number.isFinite(co2) && co2 >= 1000 ? co2Reason() : null) || iaqReason() || smellReason();
  const aqiReason = () => Number.isFinite(aq)
    ? { label: "Outdoor AQI", value: String(Math.round(aq)), tone: aq >= 101 ? "poor" : "good", note: aq >= 101 ? "Dirty" : "Clean" }
    : null;
  const pollenReason = () => pol
    ? { label: "Pollen outside", value: pol.category ? `${pol.name} · ${pol.category}` : `${pol.name} · score ${pol.score}`, tone: pol.score >= 4 ? "poor" : "good", note: pol.score >= 4 ? "High" : "Low" }
    : null;
  const wetReason = () => Number.isFinite(ahDelta)
    ? { label: "Outdoor moisture", value: `${Math.abs(ahDelta).toFixed(1)} g/m³ more than inside`, tone: "fair", note: "Wetter" }
    : null;
  const some = (...rs) => rs.filter(Boolean).slice(0, 3);

  if (outdoorBad) return { action: "keep-closed", text: `Keep windows shut: outdoor air is ${Math.round(aq)} AQI.`, reasons: some(aqiReason(), staleReason()) };
  if (indoorStale && (pollenHigh && wantsPollen)) {
    return { action: "filter", text: `Air inside is stale but ${pol.name} pollen is high outside. Run the fan with a HEPA filter instead of opening windows.`, reasons: some(staleReason(), pollenReason(), aqiReason()) };
  }
  if (indoorStale && outdoorWet) return { action: "fan", text: "Air is stale but it is more humid outside. Use the exhaust fan rather than opening windows.", reasons: some(staleReason(), wetReason()) };
  if (indoorStale) return { action: "open", text: "Open windows for 10 minutes: indoor air is stale and outdoor air is fine.", reasons: some(staleReason(), aqiReason(), pol && pol.score < 4 ? pollenReason() : null) };
  return { action: "none", text: "No ventilation needed right now.", reasons: some(co2Reason(), aqiReason(), pol && pol.score < 4 ? pollenReason() : null) };
}

/** Score helper retained for tests and the UI legend. */
export function deficitToPct(d) {
  return Math.round(clamp(interp(d, [[0, 0], [0.3, 40], [0.7, 75], [1.4, 100]]), 0, 100));
}
