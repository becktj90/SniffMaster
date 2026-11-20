import test from "node:test";
import assert from "node:assert/strict";
import * as h from "../lib/homeAir.js";
import { fetchGooglePollen, parseGooglePollen, monthlyCap } from "../lib/pollen.js";
import { parseOpenMeteoPollen } from "../lib/outdoor.js";
import { startLocalStore, sql } from "./localStore.mjs";
import { shouldSampleCoarse, HOME_COARSE_STEP_MS, MAX_HOME_COARSE, MAX_HISTORY } from "../lib/store.js";
import { buildSummary, reportFallbackText, composeReportSms } from "../api/daily-summary.js";

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

test("home history retention covers the windows the dashboard claims", () => {
  assert.equal(MAX_HOME_COARSE * HOME_COARSE_STEP_MS, 7 * 24 * 3600 * 1000);
  assert.equal(MAX_HISTORY, 6 * 60);
  assert.equal(shouldSampleCoarse(undefined, 1000), true);
  assert.equal(shouldSampleCoarse(0, HOME_COARSE_STEP_MS - 1), false);
  assert.equal(shouldSampleCoarse(0, HOME_COARSE_STEP_MS), true);
});

test("mold window matches the samples on hand, including 1-minute posts", () => {
  const full = h.moldRisk(hist(65), { humidity: 65 }, now);
  assert.equal(full.pct, 100);
  assert.equal(full.windowComplete, true);
  assert.ok(full.coverageHours > 70);

  const minutes = Array.from({ length: 432 }, (_, i) => ({ receivedAt: now - i * 60000, humidity: 65, tempF: 73 }));
  const short = h.moldRisk(minutes, { humidity: 65 }, now);
  assert.equal(short.pct, 20);
  assert.equal(short.windowComplete, false);
  assert.ok(short.coverageHours > 7 && short.coverageHours < 8);

  const compact = minutes.map((r) => ({ t: r.receivedAt, rh: r.humidity, tc: 23 }));
  const viaCompact = h.moldRisk(h.mergeClimateHistory(compact), { humidity: 65 }, now);
  assert.equal(viaCompact.pct, short.pct);
  assert.equal(viaCompact.windowComplete, false);
  const summary = h.buildHomeMetrics({ humidity: 65, tempF: 73, iaq: 40, co2: 600 }, minutes, { now });
  assert.match(summary.visitor.notes.join(" "), /still filling in/);
});

test("dust-mite window covers 7 days of 10-minute samples", () => {
  const week = Array.from({ length: 1008 }, (_, i) => ({ receivedAt: now - i * 600000, humidity: 70, tempF: 73 }));
  const risk = h.dustMiteRisk(week, { humidity: 70, tempF: 73 }, now);
  assert.equal(risk.windowComplete, true);
  assert.ok(risk.coverageHours >= 160);
});

test("home morning report uses home wording and skips the launch line", async () => {
  const samples = Array.from({ length: 4 }, (_, i) => ({
    receivedAt: now - i * 60000,
    humidity: 48,
    tempC: 22,
    iaq: 40,
    co2: 700,
  }));
  const summary = buildSummary(samples, undefined, "home");
  assert.equal(summary.environmentType, "home");
  assert.match(summary.controlsNote, /house/i);
  assert.match(reportFallbackText(summary), /home|house/i);
  const sms = await composeReportSms(summary, [{ name: "Falcon 9", t0: new Date(now).toISOString() }]);
  assert.doesNotMatch(sms.smsText, /Cape/);
  assert.match(sms.smsText, /home|house/i);
});

test("data gaps are not counted as damp time", () => {
  const sparse = [{ receivedAt: now - 3600e3 * 60, humidity: 80 }, { receivedAt: now - 60e3, humidity: 80 }];
  assert.ok(h.hoursAtOrAboveRh(sparse, 70, 72, now) < 1);
});

test("score re-weights over missing sensors and reports coverage honestly", () => {
  const m = h.buildHomeMetrics({ ...hist(48, 1)[0], iaq: 40, co2: 600, airScore: 27, tier: 2, primary: "Laundry", primaryConf: 63 }, hist(48), { now });
  assert.equal(m.particulate.measured, false);
  assert.equal(m.score.components.find((c) => c.key === "particulate").score, null);
  assert.ok(m.score.value >= 85);
  const cov = Object.fromEntries(m.coverage.map((c) => [c.metric, c.source]));
  assert.equal(cov["Indoor particulate (PM1/2.5/4/10)"], "missing");
  assert.equal(cov["CO₂"], "estimated");
  assert.deepEqual(m.device, {
    airScore: 27,
    airScoreDirection: "lower-is-cleaner",
    oledDeviceScore: 73,
    oledDeviceScoreDirection: "higher-is-cleaner",
    smellTier: 2,
    primary: "Laundry",
    primaryConf: 63,
  });
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
  const { d, calls } = deps({ incr: async () => { throw new Error("store down"); } });
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

test("e2e: /api/home-stats against local Turso + stubbed network", async () => {
  const local = startLocalStore();
  delete process.env.GOOGLE_POLLEN_API_KEY;
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    urls.push(String(u));
    return { ok: true, json: async () => String(u).includes("air-quality") ? { current: { pm2_5: 6, pm10: 11, us_aqi: 25, ozone: 40, uv_index: 2, grass_pollen: null } } : { current: { temperature_2m: 12, relative_humidity_2m: 60, dew_point_2m: 4, rain: 0 } } };
  };
  const { putSnapshot, getHomeSeries, incrCounter } = await import("../lib/store.js");
  await putSnapshot({ voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: 52, pressHpa: 1013, lat: 34.05, lon: -118.24, city: "LA", pm25: 12, pm10: 20, airScore: 24, tier: 1, primary: "Clean Air", primaryConf: 0 });
  await putSnapshot({ voc: 0.5, iaq: 55, co2: 700, tempF: 72, humidity: 53, pressHpa: 1013, lat: 34.05, lon: -118.24, city: "LA", pm25: 12, pm10: 20, airScore: 31, tier: 2, primary: "Laundry", primaryConf: 22 });
  const series = await getHomeSeries();
  assert.equal(series.fine.length, 2);
  assert.equal(series.coarse.length, 1);
  assert.equal(series.fine[0].rh, 53);
  assert.equal(series.coarse[0].rh, 52);
  const counterKey = "sniffmaster:counter:pollen_calls:test-repair";
  const counterExpiry = async () =>
    Number((await sql(local.file, "SELECT expires_at AS e FROM counters WHERE key = ?", [counterKey])).rows[0]?.e);
  assert.equal(await incrCounter("pollen_calls:test-repair", 100), 1);
  assert.ok((await counterExpiry()) > Date.now());
  // Drop the expiry only: the value survives and the next incr repairs the TTL.
  await sql(local.file, "UPDATE counters SET expires_at = NULL WHERE key = ?", [counterKey]);
  assert.equal(await incrCounter("pollen_calls:test-repair", 100), 2);
  assert.ok((await counterExpiry()) > Date.now());
  const extras = (await import("../api/extras.js")).default;
  let status = 0, payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; }, json(p) { payload = p; return this; }, end() { return this; } };
  await extras({ method: "GET", query: { fn: "home-stats" } }, res);
  globalThis.fetch = realFetch; local.close();
  assert.equal(status, 200);
  assert.equal(payload.mode, "home");
  assert.equal(payload.particulate.measured, true);
  assert.equal(payload.outdoor.pm25, 6);
  assert.deepEqual(payload.device, {
    airScore: 31,
    airScoreDirection: "lower-is-cleaner",
    oledDeviceScore: 69,
    oledDeviceScoreDirection: "higher-is-cleaner",
    smellTier: 2,
    primary: "Laundry",
    primaryConf: 22,
  });
  assert.equal(payload.pollen.ok, false);               // no key set => honest "unavailable", no Google call
  assert.ok(!urls.some((u) => u.includes("googleapis")));
  assert.ok(payload.score.value > 0 && Array.isArray(payload.series.t));
  assert.equal(payload.solar, undefined);            // dead Google Solar fetch removed
  assert.equal(payload.ventilation.action, "none");  // co2 700, clean outdoor air
  assert.ok(payload.ventilation.reasons.every((r) => r.tone === "good"));
  assert.ok(!JSON.stringify(payload).includes("AIzaSy"));
});
