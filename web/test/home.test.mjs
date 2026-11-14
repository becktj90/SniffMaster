import test from "node:test";
import assert from "node:assert/strict";
import * as h from "../lib/homeAir.js";
import { fetchGooglePollen, parseGooglePollen, monthlyCap } from "../lib/pollen.js";
import { parseOpenMeteoPollen } from "../lib/outdoor.js";
import { startFakeUpstash } from "./fakeUpstash.mjs";

const now = Date.now();
const hist = (rh, n = 432) => Array.from({ length: n }, (_, i) => ({ receivedAt: now - i * 600000, humidity: rh, tempF: 73 }));

test("psychrometrics", () => {
  assert.ok(Math.abs(h.dewPointC(22, 50) - 11.1) < 0.2);
  assert.ok(Math.abs(h.absoluteHumidity(22, 50) - 9.8) < 0.3);
});

test("EPA AQI (2024 PM2.5 breakpoints)", () => {
  assert.equal(h.aqiPm25(9.0), 50);
  assert.equal(h.aqiPm25(35.4), 100);
  assert.equal(h.aqiPm10(54), 50);
  assert.equal(h.aqiCategory(h.aqiPm25(60)), "Unhealthy");
  assert.ok(Number.isNaN(h.aqiPm25(NaN)));
});

test("mold risk rises with sustained humidity, not a dry home", () => {
  assert.equal(h.moldRisk(hist(45), { humidity: 45 }, now).pct, 0);
  assert.ok(h.moldRisk(hist(75), { humidity: 75 }, now).pct >= 75);
});

test("data gaps are not counted as damp time", () => {
  const sparse = [{ receivedAt: now - 3600e3 * 60, humidity: 80 }, { receivedAt: now - 60e3, humidity: 80 }];
  assert.ok(h.hoursAtOrAboveRh(sparse, 70, 72, now) < 1);
});

test("score re-weights over missing sensors and reports coverage honestly", () => {
  const m = h.buildHomeMetrics({ ...hist(48, 1)[0], iaq: 40, co2: 600 }, hist(48), { now });
  assert.equal(m.particulate.measured, false);
  assert.equal(m.score.components.find((c) => c.key === "particulate").score, null);
  assert.ok(m.score.value >= 85);
  const cov = Object.fromEntries(m.coverage.map((c) => [c.metric, c.source]));
  assert.equal(cov["Indoor particulate (PM1/2.5/4/10)"], "missing");
  assert.equal(cov["CO₂"], "estimated");
  const m2 = h.buildHomeMetrics({ ...hist(48, 1)[0], iaq: 40, co2: 600, co2True: 650, pm25: 80, hcho: 90 }, hist(48), { now });
  assert.equal(m2.gases.co2Source, "sensor");
  assert.equal(m2.particulate.measured, true);
  assert.ok(m2.score.value < m.score.value);
});

test("home breaches", () => {
  assert.deepEqual(h.evaluateHomeBreaches({ pm25: 60, hcho: 90, humidity: 20 }).map((b) => b.key), ["pm25", "hcho", "dry"]);
  assert.deepEqual(h.evaluateHomeBreaches({ pm25: 5 }), []);
  for (const b of h.evaluateHomeBreaches({ pm25: 60, hcho: 90, humidity: 20 })) assert.match(b.message, /^[\x20-\x7e]+$/); // GSM-7-safe ASCII
});

test("pet allergen estimate is honest and uses only available signals", () => {
  const odors = Array(20).fill(0); odors[16] = 80;
  const m = h.buildHomeMetrics({ ...hist(48, 1)[0], iaq: 60, co2: 1300, odors }, hist(48), { now });
  assert.equal(m.petAllergen.measuredDirectly, false);
  assert.equal(m.petAllergen.confidence, "low");           // odor only, no PM sensor
  assert.ok(m.petAllergen.index >= 50);
  const withPm = h.buildHomeMetrics({ ...hist(48, 1)[0], iaq: 60, co2: 1300, odors, pm25: 8, pm10: 30 }, hist(48), { now });
  assert.equal(withPm.petAllergen.confidence, "medium");
  const none = h.buildHomeMetrics({ ...hist(48, 1)[0] }, hist(48), { now });
  assert.equal(none.petAllergen.index, null);
  assert.match(m.visitor.disclaimer, /not measured directly/);
  assert.equal(m.visitor.petAllergen.level, m.petAllergen.level);
});

const KEY = "test-key-do-not-leak";
function deps(over = {}) {
  const mem = new Map(); const counters = new Map();
  let calls = 0;
  return {
    calls: () => calls,
    d: {
      env: { GOOGLE_POLLEN_API_KEY: KEY, ...over.env },
      now,
      cacheGet: async (k) => mem.get(k) ?? null,
      cacheSet: async (k, v) => void mem.set(k, v),
      incr: over.incr || (async (k) => { counters.set(k, (counters.get(k) || 0) + 1); return counters.get(k); }),
      fetchImpl: over.fetchImpl || (async (url) => { calls++; assert.ok(url.includes("pollen.googleapis.com")); return { ok: true, json: async () => ({ dailyInfo: [{ date: { year: 2026, month: 11, day: 14 }, pollenTypeInfo: [{ code: "TREE", displayName: "Tree", inSeason: true, indexInfo: { value: 3, category: "Moderate" } }], plantInfo: [{ code: "OAK", displayName: "Oak", indexInfo: { value: 3, category: "Moderate" } }] }] }) }; }),
    },
  };
}
const loc = { lat: 34.05, lon: -118.24 };

test("pollen: no key => zero network calls", async () => {
  const { d, calls } = deps({ env: { GOOGLE_POLLEN_API_KEY: "" } });
  const r = await fetchGooglePollen(loc, d);
  assert.equal(r.ok, false); assert.equal(calls(), 0);
});

test("pollen: cached for repeat lookups (1 call, many requests)", async () => {
  const { d, calls } = deps();
  const a = await fetchGooglePollen(loc, d);
  for (let i = 0; i < 20; i++) await fetchGooglePollen({ lat: 34.04, lon: -118.23 }, d); // same 0.1° cell
  assert.equal(a.ok, true); assert.equal(calls(), 1);
});

test("pollen: monthly cap hard-stops calls", async () => {
  const { d, calls } = deps({ env: { POLLEN_MONTHLY_CAP: "2" } });
  let n = 0;
  for (const lat of [10, 20, 30, 40, 50]) { await fetchGooglePollen({ lat, lon: 5 }, d); n++; }
  assert.equal(calls(), 2);
});

test("pollen: counter failure => no call (fail closed)", async () => {
  const { d, calls } = deps({ incr: async () => { throw new Error("redis down"); } });
  const r = await fetchGooglePollen(loc, d);
  assert.equal(r.ok, false); assert.equal(calls(), 0);
});

test("pollen: failures are negative-cached; key never appears in results", async () => {
  const { d } = deps({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  let c = 0; const f = d.fetchImpl; d.fetchImpl = async (u) => { c++; return f(u); };
  const r1 = await fetchGooglePollen(loc, d); const r2 = await fetchGooglePollen(loc, d);
  assert.equal(c, 1);
  assert.ok(!JSON.stringify([r1, r2]).includes(KEY));
});

test("pollen parsing + default cap", () => {
  assert.equal(monthlyCap({}), 300);
  assert.equal(parseGooglePollen({}), null);
  assert.equal(parseOpenMeteoPollen({ grass_pollen: 120, birch_pollen: null }).plants[0].category, "High");
  assert.equal(parseOpenMeteoPollen({ grass_pollen: null }), null);
});

test("e2e: /api/home-stats against fake Redis + stubbed network", async () => {
  const up = await startFakeUpstash();
  process.env.UPSTASH_REDIS_REST_URL = up.url; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  delete process.env.GOOGLE_POLLEN_API_KEY;
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).startsWith(up.url)) return realFetch(u, o);
    urls.push(String(u));
    return { ok: true, json: async () => String(u).includes("air-quality") ? { current: { pm2_5: 6, pm10: 11, us_aqi: 25, ozone: 40, uv_index: 2, grass_pollen: null } } : { current: { temperature_2m: 12, relative_humidity_2m: 60, dew_point_2m: 4, rain: 0 } } };
  };
  const { putSnapshot } = await import("../lib/store.js");
  await putSnapshot({ voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: 52, pressHpa: 1013, lat: 34.05, lon: -118.24, city: "LA", pm25: 12, pm10: 20 });
  const extras = (await import("../api/extras.js")).default;
  let status = 0, payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; }, json(p) { payload = p; return this; }, end() { return this; } };
  await extras({ method: "GET", query: { fn: "home-stats" } }, res);
  globalThis.fetch = realFetch; up.close();
  assert.equal(status, 200);
  assert.equal(payload.mode, "home");
  assert.equal(payload.particulate.measured, true);
  assert.equal(payload.outdoor.pm25, 6);
  assert.equal(payload.pollen.ok, false);               // no key set => honest "unavailable", no Google call
  assert.ok(!urls.some((u) => u.includes("googleapis")));
  assert.ok(payload.score.value > 0 && Array.isArray(payload.series.t));
  assert.ok(!JSON.stringify(payload).includes("AIzaSy"));
});
