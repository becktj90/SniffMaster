import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSmell, allergyOutlook, ventilationAdvice, parseTriggers, parseSeverities, canonicalSeverities, applySeverity } from "../lib/homeInsights.js";
import { buildHomeMetrics } from "../lib/homeAir.js";
import { fallbackInsights, insightFacts } from "../lib/insights.js";

const now = Date.now();
// Deterministic pseudo-noise.
const noise = (i) => Math.sin(i * 12.9898) * 0.03;
// Clean room: gas resistance falls with humidity (physically), 24h of 1-min posts.
function day({ spikeFromMin = null, spikeFactor = 0.4, wetMin = null }) {
  return Array.from({ length: 24 * 60 }, (_, i) => {
    const minsAgo = i;
    const rh = wetMin !== null && minsAgo < wetMin ? 70 : 45 + 5 * Math.sin(i / 200);
    const ah = 8 + (rh - 45) * 0.2;
    let g = 200000 * Math.exp(-0.08 * (ah - 8) + noise(i));
    if (spikeFromMin !== null && minsAgo < spikeFromMin) g *= spikeFactor;
    return { receivedAt: now - minsAgo * 60000, gasR: g, humidity: rh, tempF: 72, iaqAcc: 3 };
  });
}
const latestOf = (h, extra = {}) => ({ ...h[0], ...extra });

test("clean room does not smell", () => {
  const h = day({});
  const s = analyzeSmell(latestOf(h), h, { now });
  assert.equal(s.smellsBad, false);
  assert.equal(s.level, "Fresh");
  assert.equal(s.headline, "Air smells fresh.");
});

test("sustained drop in gas resistance is flagged, with duration", () => {
  const h = day({ spikeFromMin: 20 });
  const odors = Array(20).fill(0); odors[10] = 70;
  const s = analyzeSmell(latestOf(h, { odors }), h, { now });
  assert.equal(s.smellsBad, true);
  assert.match(s.headline, /garbage/);
  assert.ok(s.sinceMinutes >= 15 && s.sinceMinutes <= 22, String(s.sinceMinutes));
  assert.ok(s.action);
});

test("a raw gas change is not a smell when every odor class is background", () => {
  const h = day({ spikeFromMin: 20 });
  const odors = Array(20).fill(0);
  odors[13] = 8;
  const s = analyzeSmell(latestOf(h, { odors }), h, { now });
  assert.equal(s.smellsBad, false);
  assert.equal(s.unclassifiedGasChange, true);
  assert.equal(s.state, "unclassified");
  assert.equal(s.level, "Unclassified gas change");
  assert.equal(s.action, null);
  assert.match(s.headline, /no odor class is confirmed/i);
  assert.match(s.detail, /below background/i);
});

test("a single noisy sample is not an alarm", () => {
  const h = day({ spikeFromMin: 1 });
  const s = analyzeSmell(latestOf(h), h, { now });
  assert.equal(s.smellsBad, false);
});

test("humid air alone (shower) is not mistaken for a bad smell", () => {
  const h = day({ wetMin: 30 });
  const s = analyzeSmell(latestOf(h), h, { now });
  assert.equal(s.smellsBad, false, JSON.stringify(s));
});

test("benign odor class (coffee) does not read as smelly unless strong", () => {
  const h = day({ spikeFromMin: 20, spikeFactor: 0.65 });
  const odors = Array(20).fill(0); odors[9] = 80;
  const s = analyzeSmell(latestOf(h, { odors }), h, { now });
  assert.equal(s.smellsBad, false);
});

test("safety odors get a safety action", () => {
  const h = day({ spikeFromMin: 20 });
  const odors = Array(20).fill(0); odors[14] = 80;
  const s = analyzeSmell(latestOf(h, { odors }), h, { now });
  assert.equal(s.safety, true);
  assert.match(s.action, /gas/i);
});

test("too little history says it is learning instead of guessing", () => {
  const h = day({}).slice(0, 10);
  assert.equal(analyzeSmell(latestOf(h), h, { now }).state, "learning");
});

test("low sensor accuracy lowers confidence", () => {
  const h = day({ spikeFromMin: 20 }).map((r) => ({ ...r, iaqAcc: 0 }));
  assert.equal(analyzeSmell(latestOf(h), h, { now }).confidence, "low");
});

test("a low-accuracy gas shift is not a strong smell", () => {
  const h = day({ spikeFromMin: 20 }).map((r) => ({ ...r, iaqAcc: 1 }));
  const odors = Array(20).fill(0);
  odors[10] = 70;
  const latest = latestOf(h, { odors, iaqAcc: 1, iaq: 40, co2: 600, stab: 1, runIn: 1 });
  const s = analyzeSmell(latest, h, { now });
  assert.equal(s.smellsBad, false);
  assert.notEqual(s.level, "Strong smell");
  assert.equal(s.cause, null);
  assert.doesNotMatch(s.headline, /strong smell/i);
  const home = {
    score: { value: 90, grade: "Great" },
    smell: s,
    climate: { tempF: 72, humidity: 45 },
    gases: { iaq: 40, co2: 600 },
  };
  const facts = insightFacts(home, { iaqAcc: 1, stab: 1, runIn: 1, iaq: 40, co2: 600, gasR: latest.gasR }, null);
  const out = fallbackInsights(facts);
  assert.match(out.headline, /great shape/i);
  assert.doesNotMatch(out.headline, /smells a little off/i);
  assert.match(out.summary, /sensor is running/i);
  assert.match(out.summary, /room air has not varied/i);
  assert.doesNotMatch(out.summary, /still calibrating/i);
  assert.equal(facts.indoor.sensorCalibrated, false);
});

test("a cold boot still says the sensor is calibrating", () => {
  const facts = insightFacts(
    { score: { value: 90, grade: "Great" }, climate: { tempF: 70, humidity: 40 }, gases: { iaq: 25, co2: 450 } },
    { iaqAcc: 0, stab: 0, runIn: 0, iaq: 25, co2: 450, gasR: 150000 },
    null,
  );
  const out = fallbackInsights(facts);
  assert.match(out.summary, /still calibrating/i);
  assert.doesNotMatch(out.summary, /room air has not varied/i);
  assert.equal(facts.score, 90);
});

test("parseTriggers whitelists", () => {
  assert.deepEqual(parseTriggers("cat,pollen,evil,cat"), ["cat", "pollen"]);
});

test("parseTriggers accepts the new allergy triggers", () => {
  assert.deepEqual(parseTriggers("dust,voc,dryAir,treePollen,grassPollen,weedPollen"), ["dust", "voc", "dryAir", "treePollen", "grassPollen", "weedPollen"]);
});

test("parseSeverities whitelists keys and levels", () => {
  assert.deepEqual(parseSeverities("cat:severe,pollen:mild,evil:severe,cat:banana"), { cat: "severe", pollen: "mild" });
  assert.deepEqual(parseSeverities({ dog: "severe", smoke: "off" }), { dog: "severe" });
  assert.deepEqual(parseSeverities(""), {});
  assert.equal(canonicalSeverities("pollen:mild,cat:severe"), "cat:severe,pollen:mild");
  assert.equal(canonicalSeverities("cat:moderate"), "");
});

test("applySeverity shifts one level, clamped 0–4", () => {
  assert.equal(applySeverity(2, "severe"), 3);
  assert.equal(applySeverity(4, "severe"), 4);
  assert.equal(applySeverity(2, "mild"), 1);
  assert.equal(applySeverity(0, "mild"), 0);
  assert.equal(applySeverity(3, "moderate"), 3);
  assert.equal(applySeverity(3, undefined), 3);
});

test("severity sharpens and softens the outlook, and gates the action", () => {
  const h = day({});
  const odors = Array(20).fill(0); odors[16] = 80;
  const latest = latestOf(h, { odors, iaq: 60, co2: 700 });
  const m = { ...buildHomeMetrics(latest, h, { now }), pollen };
  const base = allergyOutlook(m, ["cat"]).items[0];
  const sev = allergyOutlook(m, ["cat"], null, { cat: "severe" }).items[0];
  assert.equal(sev.baseRank, base.rank);
  assert.equal(sev.rank, Math.min(4, base.rank + 1));
  assert.equal(sev.severity, "severe");
  const mild = allergyOutlook(m, ["cat"], null, { cat: "mild" }).items[0];
  assert.equal(mild.rank, Math.max(0, base.rank - 1));
  // Dust at PM10 60 µg/m³ is rank 2: mild drops it to 1 and hides the
  // action, severe lifts it to 3 and keeps it.
  const dusty = buildHomeMetrics(latestOf(h, { pm10: 60 }), h, { now });
  const dMild = allergyOutlook(dusty, ["dust"], null, { dust: "mild" }).items[0];
  assert.equal(dMild.rank, 1);
  assert.equal(dMild.action, null);
  const dSev = allergyOutlook(dusty, ["dust"], null, { dust: "severe" }).items[0];
  assert.equal(dSev.rank, 3);
  assert.match(dSev.action, /HEPA/);
});

test("new triggers: dust, fragrances and dry air score from real readings", () => {
  const h = day({});
  const latest = latestOf(h, { pm10: 120, iaq: 160, voc: 1.2, humidity: 20, tempF: 72 });
  const m = buildHomeMetrics(latest, h, { now });
  const out = allergyOutlook(m, ["dust", "voc", "dryAir"]);
  const byKey = Object.fromEntries(out.items.map((i) => [i.key, i]));
  assert.equal(byKey.dust.rank, 3); // PM10 120 µg/m³
  assert.match(byKey.dust.reason, /Indoor coarse dust/);
  assert.equal(byKey.voc.rank, 4); // IAQ 160 ≥ 150
  assert.match(byKey.voc.reason, /VOC 1.20 ppm/);
  assert.equal(byKey.dryAir.rank, 3); // RH 20% → dryness pct ~67
  assert.match(byKey.dryAir.reason, /20% RH/);
  assert.equal(out.rank, 4);
});

test("new triggers: no sensor, no outlook item level", () => {
  const h = day({});
  const m = buildHomeMetrics(latestOf(h), h, { now });
  const out = allergyOutlook(m, ["dust", "voc"]);
  const byKey = Object.fromEntries(out.items.map((i) => [i.key, i]));
  assert.equal(byKey.dust.rank, 0);
  assert.equal(byKey.voc.rank, 0);
  assert.equal(byKey.voc.action, null);
});

test("new triggers: pollen split follows the family, not the worst overall", () => {
  const google = {
    ok: true,
    types: [
      { code: "GRASS", name: "Grass", value: 5, category: "Very high" },
      { code: "TREE", name: "Tree", value: 1, category: "Very low" },
      { code: "WEED", name: "Weed", value: 2, category: "Low" },
    ],
    plants: [],
  };
  const m = { pollen: google };
  const out = allergyOutlook(m, ["treePollen", "grassPollen", "weedPollen"]);
  const byKey = Object.fromEntries(out.items.map((i) => [i.key, i]));
  assert.equal(byKey.grassPollen.rank, 4);
  assert.match(byKey.grassPollen.reason, /Grass is very high/);
  assert.equal(byKey.treePollen.rank, 0);
  assert.equal(byKey.weedPollen.rank, 1);
  // The overall "pollen" trigger still takes the worst of everything.
  assert.equal(allergyOutlook(m, ["pollen"]).rank, 4);
  // Open-Meteo plants map by name: birch is a tree, ragweed a weed.
  const meteo = { ok: true, types: [], plants: [{ code: "BIRCH", name: "Birch", value: null, category: "High", grains: 120 }, { code: "RAGWEED", name: "Ragweed", value: null, category: "Low", grains: 5 }] };
  const out2 = allergyOutlook({ pollen: meteo }, ["treePollen", "weedPollen"]);
  const byKey2 = Object.fromEntries(out2.items.map((i) => [i.key, i]));
  assert.equal(byKey2.treePollen.rank, 3);
  assert.equal(byKey2.weedPollen.rank, 1);
});

const pollen = { ok: true, types: [{ name: "Grass", value: 4, category: "High" }], plants: [] };
test("personalised outlook follows the user's triggers", () => {
  const h = day({});
  const odors = Array(20).fill(0); odors[16] = 80;
  const latest = latestOf(h, { odors, iaq: 60, co2: 700 });
  const m = { ...buildHomeMetrics(latest, h, { now }), pollen };
  const cat = allergyOutlook(m, ["cat"]);
  assert.ok(cat.rank >= 2);
  assert.match(cat.items[0].action, /HEPA/);
  const pol = allergyOutlook(m, ["pollen"]);
  assert.equal(pol.level, "High");
  assert.match(pol.headline, /High risk/);
  assert.equal(allergyOutlook(m, []).level, null);
});

test("ventilation: do not open windows into high pollen for a pollen-allergic user", () => {
  const m = { gases: { co2: 1400 }, pollen, climate: { humidity: 40 }, indoorOutdoor: {} , outdoor: { usAqi: 40 } };
  assert.equal(ventilationAdvice(m, null, ["pollen"]).action, "filter");
  assert.equal(ventilationAdvice(m, null, []).action, "open");
  assert.equal(ventilationAdvice({ ...m, outdoor: { usAqi: 160 } }, null, []).action, "keep-closed");
});

test("ventilation: reasons name the readings behind the verdict", () => {
  const m = { gases: { co2: 1400 }, pollen, climate: { humidity: 40 }, indoorOutdoor: {}, outdoor: { usAqi: 40 } };
  const filter = ventilationAdvice(m, null, ["pollen"]);
  assert.deepEqual(filter.reasons.map((r) => r.label), ["Indoor CO₂", "Pollen outside", "Outdoor AQI"]);
  assert.deepEqual(filter.reasons.map((r) => r.tone), ["poor", "poor", "good"]);
  assert.equal(filter.reasons[0].value, "1,400 ppm");

  const open = ventilationAdvice(m, null, []);
  assert.deepEqual(open.reasons.map((r) => r.label), ["Indoor CO₂", "Outdoor AQI"]);

  const shut = ventilationAdvice({ ...m, outdoor: { usAqi: 160 } }, null, []);
  assert.deepEqual(shut.reasons.map((r) => r.label), ["Outdoor AQI", "Indoor CO₂"]);

  const fan = ventilationAdvice({ ...m, climate: { humidity: 60 }, indoorOutdoor: { absHumidityDelta: -5 } }, null, []);
  assert.equal(fan.action, "fan");
  assert.deepEqual(fan.reasons.map((r) => r.label), ["Indoor CO₂", "Outdoor moisture"]);

  const clear = ventilationAdvice({ gases: { co2: 620 }, pollen: { ok: false }, climate: { humidity: 40 }, indoorOutdoor: {}, outdoor: { usAqi: 30 } }, null, []);
  assert.equal(clear.action, "none");
  assert.ok(clear.reasons.every((r) => r.tone === "good"));

  // No data at all: still a safe default, but no invented reasons.
  assert.deepEqual(ventilationAdvice({}, null, []).reasons, []);
});
