import test from "node:test";
import assert from "node:assert/strict";
import { lookupEnvironment, ugPerM3, geohash } from "../lib/googleEnv.js";

const KEY = "test-maps-key-not-real";

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function hostOf(url) {
  return new URL(url).hostname;
}

test("geohash is stable at 6 characters", () => {
  assert.equal(geohash(40.7128, -74.006, 6), "dr5reg");
  assert.equal(geohash(28.4889, -80.5778, 6), geohash(28.4889, -80.5778, 6));
  assert.equal(geohash(28.4889, -80.5778, 6).length, 6);
});

test("ppb gas converts to micrograms and EPA 3 stays 3", () => {
  const co = ugPerM3("co", { value: 4000, units: "PARTS_PER_BILLION" });
  assert.ok(Math.abs(co - (4000 * 28.01) / 24.45) < 0.05);
  assert.equal(ugPerM3("pm25", { value: 12.4, units: "MICROGRAMS_PER_CUBIC_METER" }), 12.4);
});

test("no Google key uses Open-Meteo and omits pollen", async () => {
  const urls = [];
  const result = await lookupEnvironment(
    { lat: 28.5, lon: -80.6 },
    {
      env: {},
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (String(url).includes("air-quality-api")) {
          return jsonRes({ current: { us_aqi: 42, pm2_5: 8.2, ozone: 30 } });
        }
        return jsonRes({
          current: {
            temperature_2m: 78,
            apparent_temperature: 80,
            relative_humidity_2m: 55,
            dew_point_2m: 60,
            weather_code: 1,
            wind_speed_10m: 12,
            wind_direction_10m: 90,
            surface_pressure: 1016.2,
          },
        });
      },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, "open-meteo");
  assert.equal(result.aq.usAqi, 42);
  assert.equal(result.pollen, undefined);
  assert.equal(urls.some((u) => u.includes("googleapis.com")), false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.ok(JSON.stringify(result).length <= 1100);
});

test("two access points geolocate, and the key never leaves the server", async () => {
  const seen = [];
  const cache = new Map();
  const result = await lookupEnvironment(
    {
      lat: 0,
      lon: 0,
      wifi: [
        { mac: "AA:BB:CC:DD:EE:01", rssi: -40, channel: 6, ssid: "secret-ssid" },
        { mac: "aa:bb:cc:dd:ee:02", rssi: -70, channel: 11 },
      ],
    },
    {
      env: { GOOGLE_MAPS_API_KEY: KEY },
      now: Date.parse("2026-11-14T12:00:00Z"),
      incr: async () => 1,
      cacheGet: async (k) => cache.get(k) || null,
      cacheSet: async (k, v) => { cache.set(k, v); },
      fetchImpl: async (url, opts) => {
        const u = String(url);
        seen.push(u);
        const host = hostOf(u);
        if (host === "www.googleapis.com") {
          const body = JSON.parse(opts.body);
          assert.equal(body.considerIp, false);
          assert.equal(body.wifiAccessPoints.length, 2);
          assert.equal(body.wifiAccessPoints[0].ssid, undefined);
          return jsonRes({ location: { lat: 28.49, lng: -80.58 }, accuracy: 40 });
        }
        if (host === "weather.googleapis.com") {
          return jsonRes({
            temperature: { degrees: 78, unit: "FAHRENHEIT" },
            feelsLikeTemperature: { degrees: 81, unit: "FAHRENHEIT" },
            dewPoint: { degrees: 61, unit: "FAHRENHEIT" },
            relativeHumidity: 54,
            wind: { speed: { value: 10, unit: "MILES_PER_HOUR" }, direction: { cardinal: "EAST" } },
            airPressure: { meanSeaLevelMillibars: 1015 },
            weatherCondition: { description: { text: "Mostly sunny and pleasant" } },
          });
        }
        if (host === "airquality.googleapis.com") {
          const body = JSON.parse(opts.body);
          assert.equal(body.customLocalAqis[0].aqi, "usa_epa");
          return jsonRes({
            indexes: [
              { code: "uaqi", aqi: 80 },
              { code: "usa_epa", aqi: 3, category: "Good air", dominantPollutant: "pm25" },
            ],
            pollutants: [
              { code: "pm25", concentration: { value: 4, units: "MICROGRAMS_PER_CUBIC_METER" } },
              { code: "co", concentration: { value: 400, units: "PARTS_PER_BILLION" } },
            ],
          });
        }
        if (host === "pollen.googleapis.com") {
          assert.equal(u.includes("plantsDescription=false"), true);
          return jsonRes({
            dailyInfo: [{
              date: { year: 2026, month: 11, day: 14 },
              pollenTypeInfo: [
                { code: "TREE", displayName: "Tree", inSeason: true, indexInfo: { value: 5 } },
                { code: "GRASS", displayName: "Grass", inSeason: true, indexInfo: { value: 1 } },
                { code: "WEED", displayName: "Weed", inSeason: false, indexInfo: { value: 0 } },
              ],
              plantInfo: [{ code: "OAK", displayName: "Oak", inSeason: true, indexInfo: { value: 4 } }],
            }],
          });
        }
        if (host === "maps.googleapis.com") {
          return jsonRes({
            results: [{ address_components: [{ long_name: "Cape Canaveral", types: ["locality", "political"] }] }],
          });
        }
        throw new Error("unexpected host " + host);
      },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, "google");
  assert.equal(result.loc.source, "wifi");
  assert.equal(result.loc.label, "Cape Canaveral");
  assert.equal(result.aq.usAqi, 3);
  assert.equal(result.aq.cat, "Good");
  assert.equal(result.pollen.tree, 5);
  assert.equal(result.pollen.top, "Oak");
  assert.equal(result.wx.cond, "Mostly sunny and plea");
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes("secret-ssid"), false);
  assert.ok(JSON.stringify(result).length <= 1100);
  assert.equal(seen.some((u) => hostOf(u) === "www.googleapis.com"), true);
  const cached = [...cache.values()][0];
  assert.equal(JSON.stringify(cached).includes("secret-ssid"), false);
});

test("one access point uses the posted coordinates", async () => {
  const hosts = [];
  const result = await lookupEnvironment(
    { lat: 33.7, lon: -84.4, wifi: [{ mac: "aa:bb:cc:dd:ee:01", rssi: -50 }] },
    {
      env: { GOOGLE_MAPS_API_KEY: KEY },
      incr: async () => 1,
      fetchImpl: async (url, opts) => {
        hosts.push(hostOf(String(url)));
        const host = hostOf(String(url));
        if (host === "weather.googleapis.com") {
          return jsonRes({ temperature: { degrees: 70, unit: "FAHRENHEIT" }, weatherCondition: { description: { text: "Clear" } } });
        }
        if (host === "airquality.googleapis.com") {
          return jsonRes({ indexes: [{ code: "usa_epa", aqi: 55, dominantPollutant: "o3" }] });
        }
        if (host === "pollen.googleapis.com") return jsonRes({ dailyInfo: [] });
        if (opts?.method === "POST" && host === "www.googleapis.com") throw new Error("geolocate should not run");
        throw new Error("unexpected " + host);
      },
    }
  );
  assert.equal(result.loc.source, "coords");
  assert.equal(result.loc.lat, 33.7);
  assert.equal(result.aq.usAqi, 55);
  assert.equal(result.aq.cat, "Moderate");
  assert.equal(hosts.includes("www.googleapis.com"), false);
});

test("a failed Google weather call drops pollen and uses Open-Meteo", async () => {
  const result = await lookupEnvironment(
    { lat: 28.5, lon: -80.6 },
    {
      env: { GOOGLE_MAPS_API_KEY: KEY },
      incr: async () => 1,
      fetchImpl: async (url) => {
        const host = hostOf(String(url));
        if (host === "weather.googleapis.com") return { ok: false, status: 500, json: async () => ({}) };
        if (host === "airquality.googleapis.com") {
          return jsonRes({ indexes: [{ code: "usa_epa", aqi: 20 }] });
        }
        if (host === "pollen.googleapis.com") {
          return jsonRes({
            dailyInfo: [{ pollenTypeInfo: [{ code: "TREE", indexInfo: { value: 4 } }] }],
          });
        }
        if (String(url).includes("air-quality-api")) return jsonRes({ current: { us_aqi: 19, pm2_5: 5 } });
        return jsonRes({ current: { temperature_2m: 75, weather_code: 0, wind_speed_10m: 4, wind_direction_10m: 0 } });
      },
    }
  );
  assert.equal(result.source, "open-meteo");
  assert.equal(result.aq.usAqi, 19);
  assert.equal(result.pollen, undefined);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("null measurements are not reported as clean air", async () => {
  const result = await lookupEnvironment(
    { lat: 28.5, lon: -80.6 },
    {
      env: {},
      fetchImpl: async (url) => {
        if (String(url).includes("air-quality-api")) return jsonRes({ current: { us_aqi: null, pm2_5: null } });
        return jsonRes({ current: { temperature_2m: 78, weather_code: null } });
      },
    }
  );
  assert.deepEqual(result, { ok: false });
});

test("a real US AQI of zero stays a good reading", async () => {
  const result = await lookupEnvironment(
    { lat: 28.5, lon: -80.6 },
    {
      env: {},
      fetchImpl: async (url) => {
        if (String(url).includes("air-quality-api")) return jsonRes({ current: { us_aqi: 0, pm2_5: 0 } });
        return jsonRes({ current: { temperature_2m: 70, weather_code: 0 } });
      },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.aq.usAqi, 0);
  assert.equal(result.aq.pm25, 0);
  assert.equal(result.aq.cat, "Good");
});

test("a cache hit returns the remaining freshness lifetime", async () => {
  const cache = new Map();
  const start = Date.parse("2026-11-15T12:00:00Z");
  let fetches = 0;
  const deps = {
    env: {},
    now: start,
    cacheGet: async (key) => cache.get(key) || null,
    cacheSet: async (key, value) => { cache.set(key, value); },
    fetchImpl: async (url) => {
      fetches++;
      if (String(url).includes("air-quality-api")) return jsonRes({ current: { us_aqi: 42, pm2_5: 8 } });
      return jsonRes({ current: { temperature_2m: 75, weather_code: 1 } });
    },
  };
  const first = await lookupEnvironment({ lat: 28.5, lon: -80.6 }, deps);
  assert.equal(first.ttlSec, 1800);
  assert.equal(first.cachedAt, undefined);
  const stored = [...cache.values()][0];
  assert.equal(stored.ttlSec, 1800);
  assert.equal(stored.cachedAt, start);
  const second = await lookupEnvironment(
    { lat: 28.5, lon: -80.6 },
    { ...deps, now: start + 29 * 60 * 1000 }
  );
  assert.equal(second.ttlSec, 60);
  assert.equal(second.cachedAt, undefined);
  assert.equal(second.aq.usAqi, 42);
  assert.equal(fetches, 2);
  assert.equal(stored.ttlSec, 1800);
});

test("total failure is a 200-shaped ok false", async () => {
  const result = await lookupEnvironment(
    { lat: 28.5, lon: -80.6 },
    { env: {}, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }
  );
  assert.deepEqual(result, { ok: false });
});
