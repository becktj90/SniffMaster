/**
 * causes.js — "what is causing this, and what should I do?"
 *
 * The sensor cannot identify a chemical. What it CAN do is watch how several
 * signals move together, and how fast. Each household event has a distinct
 * fingerprint in the rates of change:
 *
 *   shower / steam   absolute humidity jumps fast; humidity-corrected gas barely moves
 *   cooking          VOC deficit jumps fast, CO2 and temperature climb with it
 *   people / stale   CO2 climbs steadily, VOC barely moves
 *   litter / pet     pet-class odor, moderate deficit that builds over tens of minutes
 *   garbage / food   gradual deficit with garbage / sour-food odor, CO2 flat
 *   product spray    sharp spike that decays within minutes (cleaner, solvent, perfume)
 *   damp / mold      musty odor or a persistent deficit while humidity is high
 *   smoke / burning  smoke / burnt odor class: always treated as urgent
 *   slow off-gassing deficit crept up over hours with no event (new furniture, paint)
 *   outdoor intrusion indoor change tracks high outdoor AQI
 *
 * Every rule scores 0..1 from measured rates; the best rule wins only above a
 * floor, otherwise the answer is "unexplained" rather than a guess. Evidence
 * strings quote the actual numbers so the user can judge for themselves.
 * Pure functions, no I/O.
 */

import { num, absoluteHumidity, tempCOf, clamp } from "./homeAir.js";
import { gasDeficit, ODOR_NAMES } from "./homeInsights.js";

const MIN = 60 * 1000;

// Indexes into the firmware's 20-class odor array (see ODOR_NAMES).
const O = { FART: 0, MUSTY: 1, CIG: 2, ALCOHOL: 3, WEED: 4, CLEAN: 5, GAS: 6, SMOKE: 7, COOK: 8, COFFEE: 9, GARBAGE: 10, BO: 11, PERFUME: 12, LAUNDRY: 13, SULFUR: 14, SOLVENT: 15, PET: 16, SOUR: 17, BURNT: 18, CITRUS: 19 };

function rowsOf(history, now) {
  return (Array.isArray(history) ? history : [])
    .map((h) => ({
      t: num(h?.receivedAt ?? h?.t),
      co2: num(h?.co2True ?? h?.co2),
      tc: tempCOf(h),
      rh: num(h?.humidity),
      odors: Array.isArray(h?.odors) ? h.odors : null,
    }))
    .filter((r) => Number.isFinite(r.t) && r.t <= now && now - r.t <= 26 * 3600 * 1000)
    .map((r) => ({ ...r, ah: absoluteHumidity(r.tc, r.rh) }))
    .sort((a, b) => a.t - b.t);
}

/** Mean of `key` over [now-endMin-spread, now-endMin+spread]; NaN if no samples. */
function around(rows, key, now, agoMin, spreadMin = 3) {
  const lo = now - (agoMin + spreadMin) * MIN;
  const hi = now - Math.max(0, agoMin - spreadMin) * MIN;
  const v = rows.filter((r) => r.t >= lo && r.t <= hi && Number.isFinite(r[key])).map((r) => r[key]);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** Change in `key` between `agoMin` minutes ago and now. */
function delta(rows, key, now, agoMin) {
  const a = around(rows, key, now, 0, 2);
  const b = around(rows, key, now, agoMin, Math.max(2, agoMin * 0.15));
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
}

const sat = (x, lo, hi) => clamp((x - lo) / (hi - lo), 0, 1);

/**
 * Compute the rates of change the rules reason over.
 * @returns {{dCo2_30:number, dCo2_10:number, dAh_15:number, dTc_20:number, dDef_5:number, dDef_20:number, dDef_180:number, def:number, defPeak:number, defPeakMinAgo:number, odorTop:number|null, odorTopScore:number, rh:number}}
 */
export function rateFeatures(latest, history, smellGd, now = Date.now()) {
  const rows = rowsOf(history, now);
  // Latest snapshot counts as "now" even if it is not in the history list yet.
  const cur = { t: now, co2: num(latest?.co2True ?? latest?.co2), tc: tempCOf(latest), rh: num(latest?.humidity), odors: Array.isArray(latest?.odors) ? latest.odors : null };
  cur.ah = absoluteHumidity(cur.tc, cur.rh);
  if (Number.isFinite(cur.co2) || Number.isFinite(cur.rh)) rows.push(cur);

  const recent = smellGd?.recent || [];
  const defAt = (agoMin, spread = 3) => {
    const v = recent.filter((r) => now - r.t >= Math.max(0, agoMin - spread) * MIN && now - r.t <= (agoMin + spread) * MIN).map((r) => r.d);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  const def = Number.isFinite(smellGd?.deficit) ? smellGd.deficit : NaN;
  let peak = -Infinity;
  let peakAgo = NaN;
  for (const r of recent) if (r.d > peak) { peak = r.d; peakAgo = (now - r.t) / MIN; }

  // Odor class: strongest class averaged over the last 5 minutes.
  const sums = new Array(20).fill(0);
  let n = 0;
  for (const r of rows.filter((x) => now - x.t <= 5 * MIN && x.odors)) {
    r.odors.forEach((v, i) => { if (i < 20) sums[i] += num(v, 0); });
    n++;
  }
  let top = null;
  let topScore = 0;
  if (n) {
    sums.forEach((s, i) => { const m = s / n; if (m > topScore) { topScore = m; top = i; } });
  }

  return {
    dCo2_30: delta(rows, "co2", now, 30),
    dCo2_10: delta(rows, "co2", now, 10),
    dAh_15: delta(rows, "ah", now, 15),
    dTc_20: delta(rows, "tc", now, 20),
    dDef_5: Number.isFinite(def) && Number.isFinite(defAt(5)) ? def - defAt(5) : NaN,
    dDef_20: Number.isFinite(def) && Number.isFinite(defAt(20, 5)) ? def - defAt(20, 5) : NaN,
    dDef_180: Number.isFinite(def) ? def - (rows.length ? deficitHoursAgo(smellGd, now, 3) : NaN) : NaN,
    def,
    defPeak: Number.isFinite(peak) ? peak : NaN,
    defPeakMinAgo: peakAgo,
    odorTop: top,
    odorTopScore: topScore,
    rh: cur.rh,
    co2: cur.co2,
  };
}

// The recent[] window is only an hour; for the slow-drift rule use the full series.
function deficitHoursAgo(gd, now, hours) {
  const v = (gd?.series || []).filter((r) => Math.abs(now - r.t - hours * 3600 * 1000) <= 30 * MIN).map((r) => r.d);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

const f1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : "?");
const sgn = (x) => (x >= 0 ? "+" : "") + f1(x);

const RULES = [
  {
    key: "smoke",
    label: "Smoke or burning",
    urgent: true,
    action: "Check the stove, oven and outlets now. Open windows and leave if you cannot find it.",
    score: (f) => (f.odorTop === O.SMOKE || f.odorTop === O.BURNT || f.odorTop === O.CIG) && f.odorTopScore >= 45 ? sat(f.odorTopScore, 40, 80) * (f.def > 0.25 ? 1 : 0.5) : 0,
    evidence: (f) => [`Smoke-type odor score ${Math.round(f.odorTopScore)}`, `VOC deficit ${f1(f.def)}`],
  },
  {
    key: "steam",
    label: "Shower or steam",
    action: "Run the bath fan and crack the door. Humidity will fall back on its own in about 20 minutes.",
    score: (f) => sat(f.dAh_15, 1.5, 5) * (f.def > 0.6 ? 0.5 : 1) * (f.dCo2_10 > 60 ? 0.7 : 1),
    evidence: (f) => [`Absolute humidity ${sgn(f.dAh_15)} g/m³ in 15 min`, `Humidity ${Math.round(f.rh)}%`],
  },
  {
    key: "cooking",
    label: "Cooking",
    action: "Turn on the range hood and open a window. Keep the cat out of the kitchen while it clears.",
    score: (f) => {
      const burst = sat(f.dDef_20, 0.25, 0.8);
      const co2 = sat(f.dCo2_30, 60, 250);
      const temp = sat(f.dTc_20, 0.4, 2);
      const odor = f.odorTop === O.COOK || f.odorTop === O.BURNT ? sat(f.odorTopScore, 30, 70) : 0;
      return clamp(burst * (0.35 + 0.25 * co2 + 0.15 * temp) + 0.35 * odor, 0, 1) * (f.odorTop === O.PET ? 0.5 : 1);
    },
    evidence: (f) => [`VOC deficit ${sgn(f.dDef_20)} in 20 min`, `CO₂ ${sgn(f.dCo2_30)} ppm in 30 min`, f.odorTop === O.COOK ? `Cooking odor score ${Math.round(f.odorTopScore)}` : null],
  },
  {
    key: "occupancy",
    label: "People in the room / stale air",
    action: "Open a window or run a fan for 10 minutes. CO₂ climbing like this means the air is not being replaced.",
    score: (f) => sat(f.dCo2_30, 120, 400) * (f.def > 0.45 ? 0.5 : 1) * (f.dAh_15 > 3 ? 0.6 : 1),
    evidence: (f) => [`CO₂ ${sgn(f.dCo2_30)} ppm in 30 min`, f.co2 ? `Now ${Math.round(f.co2)} ppm` : null],
  },
  {
    key: "litter",
    label: "Litter box or pet area",
    action: "Scoop the litter box and empty the bag. If the smell returns within hours, deep-clean the tray and the floor beside it.",
    score: (f) => (f.odorTop === O.PET ? sat(f.odorTopScore, 35, 75) * (0.55 + 0.45 * sat(f.def, 0.15, 0.5)) : 0),
    evidence: (f) => [`Pet / litter odor score ${Math.round(f.odorTopScore)}`, `VOC deficit ${f1(f.def)}`, Number.isFinite(f.dDef_20) ? `Built ${sgn(f.dDef_20)} over 20 min` : null],
  },
  {
    key: "garbage",
    label: "Trash or spoiled food",
    action: "Take the trash out and check the bin, the drain and the fridge for anything past its date.",
    score: (f) => ((f.odorTop === O.GARBAGE || f.odorTop === O.SOUR) ? sat(f.odorTopScore, 35, 75) * (0.5 + 0.5 * sat(f.def, 0.15, 0.5)) * (f.dCo2_30 > 150 ? 0.6 : 1) : 0),
    evidence: (f) => [`${ODOR_NAMES[f.odorTop]} odor score ${Math.round(f.odorTopScore)}`, `VOC deficit ${f1(f.def)}`],
  },
  {
    key: "product",
    label: "Cleaner, solvent or fragrance",
    action: "Ventilate while it dries. Do not mix cleaning products. It should fade within 30 minutes.",
    score: (f) => {
      const spike = sat(f.defPeak, 0.5, 1.4);
      const decaying = Number.isFinite(f.defPeakMinAgo) && f.defPeakMinAgo >= 2 && f.def < f.defPeak * 0.8 ? 1 : 0.5;
      const cls = [O.CLEAN, O.SOLVENT, O.PERFUME, O.CITRUS, O.ALCOHOL].includes(f.odorTop) ? sat(f.odorTopScore, 30, 70) : 0;
      return clamp(0.45 * spike * decaying + 0.55 * cls, 0, 1);
    },
    evidence: (f) => [`Sharp VOC spike (peak ${f1(f.defPeak)} about ${Math.round(f.defPeakMinAgo)} min ago)`, [O.CLEAN, O.SOLVENT, O.PERFUME, O.CITRUS, O.ALCOHOL].includes(f.odorTop) ? `${ODOR_NAMES[f.odorTop]} odor score ${Math.round(f.odorTopScore)}` : null],
  },
  {
    key: "damp",
    label: "Damp or mold",
    action: "Run a dehumidifier to get below 50% humidity. Check windows, sinks and corners for moisture.",
    score: (f) => clamp((f.odorTop === O.MUSTY ? sat(f.odorTopScore, 30, 70) : 0) * 0.7 + sat(f.rh, 60, 75) * sat(f.def, 0.12, 0.4) * 0.5, 0, 1),
    evidence: (f) => [`Humidity ${Math.round(f.rh)}%`, f.odorTop === O.MUSTY ? `Musty odor score ${Math.round(f.odorTopScore)}` : `VOC deficit ${f1(f.def)} while humid`],
  },
  {
    key: "offgas",
    label: "Slow off-gassing source",
    action: "Ventilate more often and look for new furniture, flooring, paint, a damp item or something decaying out of sight.",
    score: (f) => sat(f.dDef_180, 0.12, 0.45) * (Math.abs(f.dDef_20) < 0.15 ? 1 : 0.4) * (f.odorTopScore >= 45 ? 0.5 : 1),
    evidence: (f) => [`VOC deficit ${sgn(f.dDef_180)} over 3 h with no sudden event`],
  },
];

/**
 * @param {object} latest   latest snapshot
 * @param {object[]} history snapshots, any order
 * @param {{outdoor?:object, pollen?:object, now?:number, gd?:object}} opts
 */
export function analyzeCause(latest, history, opts = {}) {
  const now = opts.now ?? Date.now();
  const gd = opts.gd ?? gasDeficit(history, latest, now);
  const feats = rateFeatures(latest, history, gd, now);

  const scored = RULES.map((r) => ({ r, s: clamp(r.score(feats) || 0, 0, 1) }));
  // Outdoor intrusion: indoor deficit/PM rising while the outdoor air is bad.
  const aqi = num(opts.outdoor?.usAqi);
  const outdoorScore = Number.isFinite(aqi) && aqi >= 101 && feats.def > 0.2 ? sat(aqi, 100, 200) * 0.7 : 0;
  scored.sort((a, b) => b.s - a.s);

  const best = scored[0];
  const floor = 0.35;
  const rates = {
    co2Per30Min: Number.isFinite(feats.dCo2_30) ? Math.round(feats.dCo2_30) : null,
    humidityGm3Per15Min: Number.isFinite(feats.dAh_15) ? Math.round(feats.dAh_15 * 10) / 10 : null,
    tempCPer20Min: Number.isFinite(feats.dTc_20) ? Math.round(feats.dTc_20 * 10) / 10 : null,
    vocDeficitPer20Min: Number.isFinite(feats.dDef_20) ? Math.round(feats.dDef_20 * 100) / 100 : null,
  };

  if (outdoorScore > (best?.s ?? 0) && outdoorScore >= floor) {
    return {
      key: "outdoor",
      label: "Polluted outdoor air coming in",
      confidence: outdoorScore >= 0.6 ? "medium" : "low",
      score: Math.round(outdoorScore * 100) / 100,
      action: "Close windows and doors, and run a HEPA purifier until the outdoor air improves.",
      urgent: false,
      evidence: [`Outdoor AQI ${Math.round(aqi)}`, `VOC deficit ${f1(feats.def)}`],
      alternatives: [],
      rates,
    };
  }

  const quiet = !Number.isFinite(feats.def) || feats.def < 0.12;
  if (!best || best.s < floor) {
    return {
      key: quiet ? "none" : "unexplained",
      label: quiet ? "Nothing unusual" : "Unexplained change",
      confidence: "none",
      score: best ? Math.round(best.s * 100) / 100 : 0,
      action: quiet ? null : "Open a window for ten minutes and see whether it clears. If it keeps coming back, label it so the system can learn the pattern.",
      urgent: false,
      evidence: quiet ? [] : [`VOC deficit ${f1(feats.def)}`, Number.isFinite(feats.dCo2_30) ? `CO₂ ${sgn(feats.dCo2_30)} ppm in 30 min` : null].filter(Boolean),
      alternatives: [],
      rates,
    };
  }

  // A cause is only high-confidence when it clearly beats the runner-up and
  // the sensor is calibrated.
  const second = scored[1]?.s ?? 0;
  const acc = num(latest?.iaqAcc);
  let confidence = best.s >= 0.7 && best.s - second >= 0.2 ? "high" : best.s >= 0.5 ? "medium" : "low";
  if (Number.isFinite(acc) && acc < 2 && confidence === "high") confidence = "medium";

  return {
    key: best.r.key,
    label: best.r.label,
    confidence,
    score: Math.round(best.s * 100) / 100,
    action: best.r.action,
    urgent: !!best.r.urgent,
    evidence: best.r.evidence(feats).filter(Boolean),
    alternatives: scored.slice(1, 3).filter((x) => x.s >= floor * 0.8).map((x) => ({ key: x.r.key, label: x.r.label, score: Math.round(x.s * 100) / 100 })),
    rates,
  };
}
