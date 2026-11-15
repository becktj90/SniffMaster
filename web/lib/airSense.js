/**
 * airSense.js — everything we can honestly say about the air you are breathing.
 *
 * Combines the on-device odor vector, humidity-corrected gas deficit, climate,
 * outdoor/pollen context, cause engine, and the worldwide odor atlas into one
 * narrative payload. Novel indices are derived, not invented sensors:
 *
 *   freshnessDebt     how far below this room's own clean-air baseline you sit
 *   sensoryLoad       0–100 "how much the nose would notice" from deficit + bouquet
 *   odorComplexity    how many distinct smell families are active at once
 *   airCharacter      plain-language character (fresh, damp, sharp, stale, smoky…)
 *   chemicalFamilies  ranked families from the atlas, never claimed as GC-MS IDs
 *   staticGap         dynamic IAQ vs static IAQ — transient odor vs background
 *   pressureStory     rising/falling barometer tendency
 *   windowLeakHint    indoor change while outdoor air is dirty
 *   breathStory       multi-sentence briefing of everything known right now
 *
 * Pure functions, no I/O.
 */

import { num, clamp } from "./homeAir.js";
import { deficitToPct } from "./homeInsights.js";
import { rankOdors, rankBouquets, atlasHonesty, ATLAS } from "./odorAtlas.js";

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** Dynamic IAQ rising above static IAQ often means a transient odor plume. */
export function staticGap(latest) {
  const iaq = num(latest?.iaq);
  const st = num(latest?.staticIaq);
  if (!Number.isFinite(iaq) || !Number.isFinite(st)) return null;
  const gap = iaq - st;
  return {
    iaq: Math.round(iaq),
    staticIaq: Math.round(st),
    gap: Math.round(gap),
    reading:
      gap >= 40 ? "A short-lived plume is lifting the live IAQ above the room background."
        : gap <= -25 ? "The live IAQ is quieter than the room's longer background — a spike may be fading."
          : "Live and background IAQ agree — the room state is steady.",
  };
}

/** Barometric tendency from recent pressure samples. */
export function pressureStory(history, latest, now = Date.now()) {
  const cur = num(latest?.pressHpa ?? latest?.pressure);
  const rows = (Array.isArray(history) ? history : [])
    .map((h) => ({ t: num(h?.receivedAt ?? h?.t), p: num(h?.pressHpa ?? h?.pressure) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.p) && now - r.t <= 6 * 3600 * 1000)
    .sort((a, b) => a.t - b.t);
  if (!Number.isFinite(cur)) return null;
  const ago = rows.filter((r) => now - r.t >= 2.5 * 3600 * 1000 && now - r.t <= 4 * 3600 * 1000);
  const prev = mean(ago.map((r) => r.p));
  if (!Number.isFinite(prev)) {
    return { hPa: Math.round(cur * 10) / 10, trend: "unknown", text: `Pressure is ${cur.toFixed(1)} hPa.` };
  }
  const d = cur - prev;
  const trend = d <= -1.5 ? "falling" : d >= 1.5 ? "rising" : "steady";
  const text =
    trend === "falling" ? `Pressure has fallen about ${Math.abs(d).toFixed(1)} hPa in a few hours — weather may be on the way.`
      : trend === "rising" ? `Pressure has risen about ${d.toFixed(1)} hPa — often clearer, quieter weather.`
        : `Pressure is steady near ${cur.toFixed(1)} hPa.`;
  return { hPa: Math.round(cur * 10) / 10, delta3h: Math.round(d * 10) / 10, trend, text };
}

/**
 * Freshness debt: percent below this room's clean baseline, plus a plain band.
 * Uses the same deficit units as analyzeSmell (ln-resistance).
 */
export function freshnessDebt(smell) {
  const d = num(smell?.deficit);
  if (!Number.isFinite(d)) return null;
  const pct = deficitToPct(d);
  const band = pct < 8 ? "clear" : pct < 20 ? "slight" : pct < 40 ? "noticeable" : pct < 60 ? "heavy" : "intense";
  return {
    pct,
    deficit: d,
    band,
    text:
      band === "clear" ? "The air matches this room's own clean baseline."
        : `Gas resistance sits about ${pct}% below this room's clean-air baseline (${band}).`,
  };
}

/** How many distinct smell families are competing — a "bouquet width". */
export function odorComplexity(ranked, { min = 22 } = {}) {
  const active = (ranked || []).filter((r) => r.score >= min);
  const families = new Set(active.map((r) => r.family));
  const n = active.length;
  const label = n <= 1 ? "simple" : n <= 3 ? "mixed" : "complex";
  return {
    activeClasses: n,
    families: [...families],
    familyCount: families.size,
    label,
    text:
      n === 0 ? "No smell class is clearly above background."
        : label === "simple" ? `One main smell family is leading: ${active[0].name}.`
          : `A ${label} bouquet — ${n} smell classes above background across ${families.size} families.`,
  };
}

/**
 * Sensory load 0–100: how much a person would notice, from deficit + top classes.
 * Not a health index — a nose-noticeability estimate.
 */
export function sensoryLoad(smell, ranked, bouquets) {
  const debt = freshnessDebt(smell);
  const top = (ranked || []).slice(0, 3).map((r) => r.score);
  const bouquet = (bouquets || [])[0]?.score || 0;
  const fromDebt = debt ? clamp(debt.pct * 1.1, 0, 70) : 0;
  const fromClasses = clamp((mean(top) || 0) * 0.45, 0, 40);
  const fromBouquet = clamp(bouquet * 0.2, 0, 20);
  const value = Math.round(clamp(fromDebt * 0.55 + fromClasses + fromBouquet * 0.5, 0, 100));
  const band = value < 20 ? "quiet" : value < 40 ? "mild" : value < 65 ? "busy" : "loud";
  return {
    value,
    band,
    text: `Sensory load ${value}/100 — the air smells ${band} relative to this room's own quiet baseline.`,
  };
}

/** Plain-language air character from climate + smell + outdoor. */
export function airCharacter({ climate = {}, smell = null, outdoor = {}, ranked = [] } = {}) {
  const tags = [];
  const rh = num(climate.humidity);
  const co2 = num(climate.co2 ?? climate.co2eq);
  const top = ranked[0];
  if (smell?.smellsBad) tags.push("smelly");
  else if (num(smell?.deficit) >= 0.12) tags.push("slightly off");
  else tags.push("fresh");

  if (Number.isFinite(rh)) {
    if (rh >= 70) tags.push("damp");
    else if (rh >= 60) tags.push("humid");
    else if (rh <= 30) tags.push("dry");
    else if (rh >= 40 && rh <= 55) tags.push("comfortable");
  }
  if (Number.isFinite(co2)) {
    if (co2 >= 1200) tags.push("stuffy");
    else if (co2 >= 900) tags.push("a bit stale");
    else if (co2 <= 700) tags.push("well aired");
  }
  const aqi = num(outdoor.usAqi ?? outdoor.aqi);
  if (Number.isFinite(aqi) && aqi >= 100) tags.push("outdoor air is dirty");
  if (top && top.score >= 40) {
    if (/combustion|smoke|burnt/i.test(top.family) || /Smoke|Burnt|Cigarette/.test(top.name)) tags.push("smoky edge");
    if (/solvent|petroleum/i.test(top.family)) tags.push("sharp / chemical");
    if (/microbial|damp|musty/i.test(top.family) || top.name === "Musty") tags.push("musty");
    if (/pleasant|fragrance|citrus|coffee/i.test(top.family) || ["Coffee", "Perfume", "Laundry", "Citrus"].includes(top.name)) tags.push("fragrant");
  }
  const unique = [...new Set(tags)];
  return {
    tags: unique,
    headline: unique.slice(0, 4).join(" · "),
    text: `Air character: ${unique.join(", ")}.`,
  };
}

/** Chemical families ranked from active atlas classes. */
export function chemicalFamilies(ranked, { min = 20 } = {}) {
  const map = new Map();
  for (const r of ranked || []) {
    if (r.score < min) continue;
    const prev = map.get(r.family) || { family: r.family, score: 0, classes: [], compounds: new Set(), senses: new Set() };
    prev.score = Math.max(prev.score, r.score);
    prev.classes.push(r.name);
    (r.compounds || []).forEach((c) => prev.compounds.add(c));
    (r.senses || []).forEach((s) => prev.senses.add(s));
    map.set(r.family, prev);
  }
  return [...map.values()]
    .map((f) => ({
      family: f.family,
      score: f.score,
      classes: f.classes,
      compounds: [...f.compounds].slice(0, 6),
      senses: [...f.senses].slice(0, 6),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Hint that outdoor pollution may be leaking indoors. */
export function windowLeakHint({ outdoor = {}, smell = null, cause = null } = {}) {
  const aqi = num(outdoor.usAqi ?? outdoor.aqi);
  if (!(Number.isFinite(aqi) && aqi >= 100)) return null;
  const smoky = /smoke|burnt|cigarette/i.test(smell?.cause?.name || "") || cause?.key === "outdoor";
  if (!smoky && aqi < 150) {
    return {
      level: "watch",
      text: `Outdoor AQI is ${Math.round(aqi)}. Keep an eye on indoor smoke-like smells if you open windows.`,
    };
  }
  return {
    level: smoky || aqi >= 150 ? "likely" : "watch",
    text: smoky
      ? `Outdoor AQI is ${Math.round(aqi)} and the indoor smell looks smoky — outdoor air may be leaking in.`
      : `Outdoor AQI is ${Math.round(aqi)}. Closing windows and running a filter is safer until it drops.`,
  };
}

/** Comfort psychrometrics in plain language. */
export function comfortStory(climate = {}) {
  const t = num(climate.tempF);
  const rh = num(climate.humidity);
  if (!Number.isFinite(t) || !Number.isFinite(rh)) return null;
  let feel = "comfortable";
  if (t >= 80 && rh >= 60) feel = "muggy";
  else if (t >= 78) feel = "warm";
  else if (t <= 64) feel = "cool";
  else if (rh >= 65) feel = "damp";
  else if (rh <= 30) feel = "dry";
  return {
    tempF: Math.round(t * 10) / 10,
    humidity: Math.round(rh),
    feel,
    text: `Indoor comfort feels ${feel} at ${t.toFixed(1)}°F and ${Math.round(rh)}% humidity.`,
  };
}

/**
 * Build the full airSense payload for home-stats / the Smell page.
 * @param {{ latest: object, history?: object[], smell?: object, cause?: object,
 *   climate?: object, outdoor?: object, pollen?: object, ventilation?: object,
 *   gases?: object, now?: number }} ctx
 */
export function buildAirSense(ctx = {}) {
  const {
    latest = {},
    history = [],
    smell = null,
    cause = null,
    climate = {},
    outdoor = {},
    pollen = null,
    ventilation = null,
    gases = {},
    now = Date.now(),
  } = ctx;

  const odors = Array.isArray(latest.odors) ? latest.odors : [];
  const ranked = rankOdors(odors);
  const active = ranked.filter((r) => r.active);
  const bouquets = rankBouquets(odors, {
    humidity: climate.humidity,
    outdoorAqi: outdoor.usAqi ?? outdoor.aqi,
  });
  const debt = freshnessDebt(smell);
  const load = sensoryLoad(smell, ranked, bouquets);
  const complexity = odorComplexity(ranked);
  const character = airCharacter({ climate: { ...climate, co2: gases.co2 ?? climate.co2 }, smell, outdoor, ranked });
  const families = chemicalFamilies(ranked);
  const gap = staticGap(latest);
  const pressure = pressureStory(history, latest, now);
  const leak = windowLeakHint({ outdoor, smell, cause });
  const comfort = comfortStory(climate);

  const pollenBits = [];
  if (pollen?.ok) {
    const items = [...(pollen.types || []), ...(pollen.plants || [])]
      .filter((x) => Number.isFinite(Number(x.value)))
      .sort((a, b) => Number(b.value) - Number(a.value));
    if (items[0]) pollenBits.push(`Top outdoor pollen: ${items[0].name} (${items[0].category || items[0].value}).`);
  }

  const know = [];
  if (smell?.headline) know.push(smell.headline);
  if (debt) know.push(debt.text);
  if (character?.headline) know.push(`Character: ${character.headline}.`);
  if (load) know.push(load.text);
  if (complexity) know.push(complexity.text);
  if (cause?.label && cause.key && cause.key !== "none") {
    know.push(`Likely situation: ${cause.label}${cause.action ? ` — ${cause.action}` : "."}`);
  }
  if (bouquets[0]) know.push(`Worldwide bouquet match: ${bouquets[0].label} (${bouquets[0].strength}). ${bouquets[0].why}`);
  if (families[0]) {
    know.push(`Leading chemical family (association): ${families[0].family} — nose notes ${families[0].senses.slice(0, 3).join(", ") || "n/a"}.`);
  }
  if (gap) know.push(gap.reading);
  if (comfort) know.push(comfort.text);
  if (pressure) know.push(pressure.text);
  if (ventilation?.text) know.push(`Windows: ${ventilation.text}`);
  if (leak) know.push(leak.text);
  pollenBits.forEach((p) => know.push(p));
  if (active[0]?.score >= 20) {
    const top = active.slice(0, 3).map((r) => `${r.name} ${r.score}`).join(", ");
    know.push(`Top smell classes: ${top}.`);
  }
  know.push(atlasHonesty());

  return {
    honesty: atlasHonesty(),
    freshnessDebt: debt,
    sensoryLoad: load,
    odorComplexity: complexity,
    character,
    families,
    bouquets: bouquets.slice(0, 6),
    odors: ranked,
    activeOdors: active.slice(0, 12),
    staticGap: gap,
    pressure,
    windowLeak: leak,
    comfort,
    cause: cause && cause.key && cause.key !== "none"
      ? { key: cause.key, label: cause.label, confidence: cause.confidence, action: cause.action, urgent: !!cause.urgent, evidence: cause.evidence || [] }
      : null,
    breathStory: know,
    atlasSize: ATLAS.length,
    bouquetCatalog: bouquets.length,
  };
}
