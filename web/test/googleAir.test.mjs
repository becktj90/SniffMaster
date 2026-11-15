import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGoogleAir, parseGoogleAirForecast, tileNearHome, tileXY, fetchGoogleAir,
} from "../lib/googleAir.js";

const SAMPLE = {
  dateTime: "2026-11-15T05:00:00Z",
  indexes: [
    { code: "uaqi", displayName: "Universal AQI", aqi: 80, category: "Excellent air quality", dominantPollutant: "o3" },
    { code: "usa_epa", displayName: "AQI (US)", aqi: 42, category: "Good air quality", dominantPollutant: "pm25" },
  ],
  pollutants: [
    {
      code: "pm25",
      displayName: "PM2.5",
      concentration: { value: 9.2, units: "MICROGRAMS_PER_CUBIC_METER" },
      additionalInfo: { effects: "Fine particles can bother lungs.", sources: "Traffic" },
    },
    { code: "no2", concentration: { value: NaN, units: "PARTS_PER_BILLION" } },
  ],
  healthRecommendations: {
    elderly: "Enjoy the outdoors.",
    generalPopulation: "Air is fine for most people.",
    children: "Fine for play.",
  },
};

test("parseGoogleAir keeps the useful outdoor metrics", () => {
  const parsed = parseGoogleAir(SAMPLE);
  assert.equal(parsed.indexes.find((i) => i.code === "usa_epa").aqi, 42);
  assert.equal(parsed.pollutants.length, 1);
  assert.equal(parsed.pollutants[0].name, "Fine dust (PM2.5)");
  assert.equal(parsed.pollutants[0].unit, "µg/m³");
  assert.equal(parsed.pollutants[0].effects, "Fine particles can bother lungs.");
  assert.equal(parsed.health.olderAdults, "Enjoy the outdoors.");
  assert.equal(parsed.health.everyone, "Air is fine for most people.");
  assert.equal(parseGoogleAir({}), null);
});

test("forecast keeps every third hour, up to eight", () => {
  const hours = Array.from({ length: 30 }, (_, i) => ({
    dateTime: `2026-11-15T${String(i).padStart(2, "0")}:00:00Z`,
    indexes: [{ code: "usa_epa", aqi: i + 1, category: "Good air quality" }],
  }));
  const out = parseGoogleAirForecast({ hourlyForecasts: hours });
  assert.equal(out.length, 8);
  assert.deepEqual(out.map((h) => h.aqi), [1, 4, 7, 10, 13, 16, 19, 22]);
});

test("heatmap tiles stay in the neighborhood", () => {
  const home = tileXY(28.5383, -81.3792, 11);
  assert.equal(tileNearHome(11, home.x, home.y, 28.5383, -81.3792), true);
  assert.equal(tileNearHome(11, home.x + 4, home.y - 4, 28.5383, -81.3792), true);
  assert.equal(tileNearHome(11, home.x + 5, home.y, 28.5383, -81.3792), false);
  assert.equal(tileNearHome(4, home.x, home.y, 28.5383, -81.3792), false);
  assert.equal(tileNearHome(13, home.x, home.y, 28.5383, -81.3792), false);
  assert.equal(tileNearHome(11, home.x, home.y, NaN, -81.3792), false);
});

test("air lookup fails closed without a key and does not call Google", async () => {
  let called = false;
  const out = await fetchGoogleAir({ lat: 28.5, lon: -81.3 }, {
    env: {},
    incr: async () => 1,
    fetchImpl: async () => { called = true; },
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not configured/);
  assert.equal(called, false);
});

test("one lookup returns current air plus the forecast and can be cached", async () => {
  let posts = 0;
  let stored = null;
  const out = await fetchGoogleAir({ lat: 28.54, lon: -81.38 }, {
    env: { GOOGLE_POLLEN_API_KEY: "test-key", AIR_MONTHLY_CAP: "5" },
    now: Date.parse("2026-11-15T12:00:00Z"),
    incr: async (key) => { assert.match(key, /^air_calls:2026-11$/); return 1; },
    cacheGet: async () => null,
    cacheSet: async (key, value) => { stored = { key, value }; },
    fetchImpl: async (url, opts) => {
      posts += 1;
      assert.equal(String(url).includes("key=test-key"), true);
      assert.equal(opts.method, "POST");
      const forecast = String(url).includes("forecast");
      return {
        ok: true,
        json: async () => (forecast
          ? { hourlyForecasts: [{ dateTime: "2026-11-15T15:00:00Z", indexes: [{ code: "usa_epa", aqi: 55, category: "Moderate air quality" }] }] }
          : SAMPLE),
      };
    },
  });
  assert.equal(posts, 2);
  assert.equal(out.ok, true);
  assert.equal(out.heatmap, true);
  assert.equal(out.indexes[1].aqi, 42);
  assert.equal(out.hourly[0].aqi, 55);
  assert.equal(stored.value.ok, true);
  assert.match(stored.key, /^gair:28\.5:-81\.4$/);
});

test("a full monthly cap blocks the request", async () => {
  let called = false;
  const out = await fetchGoogleAir({ lat: 1, lon: 2 }, {
    env: { GOOGLE_POLLEN_API_KEY: "k", AIR_MONTHLY_CAP: "1" },
    incr: async () => 2,
    fetchImpl: async () => { called = true; },
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /cap/);
  assert.equal(called, false);
});
