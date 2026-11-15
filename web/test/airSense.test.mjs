import test from "node:test";
import assert from "node:assert/strict";
import { rankOdors, rankBouquets, ATLAS, BOUQUETS } from "../lib/odorAtlas.js";
import { buildAirSense, sensoryLoad, odorComplexity, staticGap } from "../lib/airSense.js";
import { analyzeSmell } from "../lib/homeInsights.js";

test("atlas covers all twenty device odor classes", () => {
  assert.equal(ATLAS.length, 20);
  assert.ok(BOUQUETS.length >= 10);
  assert.equal(rankOdors(Array(20).fill(0)).length, 20);
});

test("rankOdors orders live scores and attaches atlas knowledge", () => {
  const odors = Array(20).fill(5);
  odors[16] = 72;
  odors[1] = 40;
  const ranked = rankOdors(odors);
  assert.equal(ranked[0].name, "Pet / litter");
  assert.equal(ranked[0].score, 72);
  assert.ok(ranked[0].compounds.includes("ammonia"));
  assert.ok(ranked[0].sources.length);
  assert.equal(ranked[1].name, "Musty");
});

test("bouquets light up for incense-like and monsoon damp patterns", () => {
  const incense = Array(20).fill(5);
  incense[7] = 70; incense[4] = 45; incense[12] = 40; incense[18] = 30;
  const b = rankBouquets(incense, {});
  assert.ok(b.some((x) => x.id === "incense"));
  const damp = Array(20).fill(5);
  damp[1] = 75; damp[10] = 30;
  assert.equal(rankBouquets(damp, { humidity: 40 }).some((x) => x.id === "monsoon_damp"), false);
  assert.ok(rankBouquets(damp, { humidity: 70 }).some((x) => x.id === "monsoon_damp"));
});

test("airSense assembles a breath story from many signals", () => {
  const history = [];
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    history.push({
      receivedAt: now - (40 - i) * 60_000,
      gasR: 120000 - i * 200,
      humidity: 55,
      temperature: 22,
      tempF: 72,
      co2: 700 + i * 5,
      iaq: 50 + (i % 5),
      staticIaq: 48,
      pressHpa: 1015 - i * 0.02,
      odors: Array(20).fill(8),
    });
  }
  const latest = {
    ...history.at(-1),
    gasR: 40000,
    iaq: 120,
    staticIaq: 55,
    odors: (() => { const o = Array(20).fill(10); o[8] = 70; o[18] = 45; o[4] = 30; return o; })(),
    iaqAcc: 3,
  };
  const smell = analyzeSmell(latest, history, { now });
  const out = buildAirSense({
    latest,
    history,
    smell,
    cause: { key: "cooking", label: "Cooking", confidence: "medium", action: "Run the hood." },
    climate: { tempF: 72, humidity: 55 },
    outdoor: { usAqi: 40 },
    gases: { co2: 900 },
    ventilation: { text: "A short airing is fine." },
    now,
  });
  assert.ok(out.breathStory.length >= 6);
  assert.ok(out.activeOdors[0].name === "Cooking" || out.activeOdors.some((o) => o.name === "Cooking"));
  assert.ok(out.bouquets.some((b) => b.id === "spice_kitchen" || b.id === "bakery_roast"));
  assert.ok(out.sensoryLoad.value >= 0);
  assert.ok(out.families.some((f) => /food|Maillard|pyrolysis|terpene/i.test(f.family)));
  assert.match(out.honesty, /not identify molecules/i);
  // The honesty disclaimer lives in `honesty` only: the client renders it as
  // the note under the story list, so it must not also appear as a story line
  // (Nov 15: it printed twice in a row in "Everything known about this air").
  assert.ok(!out.breathStory.some((line) => line === out.honesty));
  assert.ok(!out.breathStory.some((line) => /not identify molecules/i.test(line)));
  assert.equal(out.staticGap.gap, 65);
});

test("sensory load and complexity stay bounded", () => {
  const ranked = rankOdors((() => { const o = Array(20).fill(60); return o; })());
  const load = sensoryLoad({ deficit: 0.5, smellsBad: true }, ranked, [{ score: 50 }]);
  assert.ok(load.value >= 0 && load.value <= 100);
  const c = odorComplexity(ranked);
  assert.equal(c.label, "complex");
  assert.ok(c.familyCount >= 3);
});

test("staticGap needs both IAQ channels", () => {
  assert.equal(staticGap({ iaq: 80 }), null);
  assert.equal(staticGap({ iaq: 90, staticIaq: 40 }).gap, 50);
});
