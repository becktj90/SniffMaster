import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSmell, allergyOutlook, ventilationAdvice, parseTriggers } from "../lib/homeInsights.js";
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
