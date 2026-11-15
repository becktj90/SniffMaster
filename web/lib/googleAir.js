/**
 * googleAir.js — Google Maps Air Quality API, with the same cost guards as pollen.
 *
 * Uses GOOGLE_POLLEN_API_KEY (a Google Maps Platform key). The key stays on the
 * server. Current conditions and a short forecast are cached per ~11 km cell.
 * Heatmap tiles are a separate, capped, cached path in lib/airTile.js.
 */

import { monthKey } from "./pollen.js";

export const AIR_CACHE_TTL_SEC = 30 * 60;
export const AIR_FAIL_TTL_SEC = 30 * 60;
export const AIR_DEFAULT_MONTHLY_CAP = 400;

const POLLUTANT_NAMES = {
  pm25: "Fine dust (PM2.5)",
  pm10: "Dust (PM10)",
  o3: "Ozone",
  no2: "Nitrogen dioxide",
  so2: "Sulfur dioxide",
  co: "Carbon monoxide",
  nh3: "Ammonia",
  no: "Nitric oxide",
  nox: "Nitrogen oxides",
};

export function airMonthlyCap(env = process.env) {
  const n = Number(env.AIR_MONTHLY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : AIR_DEFAULT_MONTHLY_CAP;
}

function units(code) {
  if (code === "MICROGRAMS_PER_CUBIC_METER") return "µg/m³";
  if (code === "PARTS_PER_BILLION") return "ppb";
  if (code === "PARTS_PER_MILLION") return "ppm";
  return "";
}

export function parseGoogleAir(json) {
  if (!json || !Array.isArray(json.indexes) || !json.indexes.length) return null;
  const indexes = json.indexes.map((i) => ({
    code: i.code || "",
    name: i.displayName || i.code || "Air quality",
    aqi: Number.isFinite(Number(i.aqi)) ? Number(i.aqi) : null,
    category: i.category || "",
    dominant: i.dominantPollutant || "",
  }));
  const pollutants = (json.pollutants || []).map((p) => ({
    code: p.code || "",
    name: POLLUTANT_NAMES[p.code] || p.displayName || p.fullName || p.code,
    value: Number.isFinite(Number(p.concentration?.value)) ? Number(p.concentration.value) : null,
    unit: units(p.concentration?.units),
    sources: p.additionalInfo?.sources || "",
    effects: p.additionalInfo?.effects || "",
  })).filter((p) => p.value !== null);
  const h = json.healthRecommendations || {};
  return {
    source: "Google Air Quality",
    updatedAt: json.dateTime || null,
    indexes,
    pollutants,
    health: {
      olderAdults: h.elderly || "",
      everyone: h.generalPopulation || "",
      children: h.children || "",
      lungs: h.lungDiseasePopulation || "",
      heart: h.heartDiseasePopulation || "",
      active: h.athletes || "",
      pregnancy: h.pregnantWomen || "",
    },
  };
}

export function parseGoogleAirForecast(json) {
  const rows = Array.isArray(json?.hourlyForecasts) ? json.hourlyForecasts : [];
  return rows.filter((_, i) => i % 3 === 0).slice(0, 8).map((h) => {
    const us = (h.indexes || []).find((i) => i.code === "usa_epa") || (h.indexes || [])[0] || {};
    return {
      t: h.dateTime || null,
      aqi: Number.isFinite(Number(us.aqi)) ? Number(us.aqi) : null,
      category: us.category || "",
    };
  }).filter((h) => h.t && h.aqi !== null);
}

export function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((Number(lon) + 180) / 360) * n);
  const rad = (Number(lat) * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  return { x, y, n };
}

/** True when a tile is a local neighborhood around the sensor, not the whole world. */
export function tileNearHome(z, x, y, lat, lon, span = 4) {
  if (!Number.isInteger(z) || z < 6 || z > 12) return false;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const t = tileXY(lat, lon, z);
  if (x < 0 || y < 0 || x >= t.n || y >= t.n) return false;
  return Math.abs(x - t.x) <= span && Math.abs(y - t.y) <= span;
}

async function postLookup(path, body, key, fetchImpl) {
  const url = `https://airquality.googleapis.com/v1/${path}?key=${encodeURIComponent(key)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await (fetchImpl || fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: `Google Air Quality returned HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, reason: err?.name === "AbortError" ? "Google Air Quality timed out" : "Google Air Quality request failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{lat:number, lon:number}} loc
 * @param {{ env?: object, now?: number, fetchImpl?: typeof fetch,
 *   cacheGet?: (k:string)=>Promise<any>, cacheSet?: (k:string,v:any,ttl:number)=>Promise<void>,
 *   incr?: (k:string, ttl:number)=>Promise<number> }} [deps]
 */
export async function fetchGoogleAir(loc, deps = {}) {
  const env = deps.env || process.env;
  const key = env.GOOGLE_POLLEN_API_KEY;
  if (!key) return { ok: false, reason: "Google key not configured" };

  const lat = Number(loc?.lat);
  const lon = Number(loc?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ok: false, reason: "No device location yet" };
  }

  const cacheKey = `gair:${lat.toFixed(1)}:${lon.toFixed(1)}`;
  try {
    if (deps.cacheGet) {
      const hit = await deps.cacheGet(cacheKey);
      if (hit) return { ...hit, cached: true };
    }
  } catch { /* cache is best-effort */ }

  if (!deps.incr) return { ok: false, reason: "Air usage counter unavailable" };
  let used;
  try {
    used = await deps.incr(`air_calls:${monthKey(deps.now)}`, 40 * 24 * 3600);
  } catch {
    return { ok: false, reason: "Air usage counter unavailable" };
  }
  const cap = airMonthlyCap(env);
  if (used > cap) return { ok: false, reason: `Air quality monthly cap (${cap}) reached` };

  const location = { latitude: lat, longitude: lon };
  const current = await postLookup("currentConditions:lookup", {
    location,
    universalAqi: true,
    languageCode: "en",
    extraComputations: [
      "HEALTH_RECOMMENDATIONS",
      "DOMINANT_POLLUTANT_CONCENTRATION",
      "POLLUTANT_CONCENTRATION",
      "LOCAL_AQI",
      "POLLUTANT_ADDITIONAL_INFO",
    ],
  }, key, deps.fetchImpl);

  if (!current.ok) {
    const fail = { ok: false, reason: current.reason };
    if (deps.cacheSet) await deps.cacheSet(cacheKey, fail, AIR_FAIL_TTL_SEC).catch(() => {});
    return fail;
  }
  const parsed = parseGoogleAir(current.json);
  if (!parsed) {
    const fail = { ok: false, reason: "No air quality data for this location" };
    if (deps.cacheSet) await deps.cacheSet(cacheKey, fail, AIR_FAIL_TTL_SEC).catch(() => {});
    return fail;
  }

  const now = deps.now ?? Date.now();
  let hourly = [];
  let forecastUsed;
  try {
    forecastUsed = await deps.incr(`air_calls:${monthKey(deps.now)}`, 40 * 24 * 3600);
  } catch {
    forecastUsed = Infinity;
  }
  if (forecastUsed <= cap) {
    const forecast = await postLookup("forecast:lookup", {
      location,
      universalAqi: true,
      languageCode: "en",
      period: {
        startTime: new Date(now).toISOString(),
        endTime: new Date(now + 24 * 3600 * 1000).toISOString(),
      },
    }, key, deps.fetchImpl);
    hourly = forecast.ok ? parseGoogleAirForecast(forecast.json) : [];
  }
  const result = { ok: true, heatmap: true, ...parsed, hourly };
  if (deps.cacheSet) await deps.cacheSet(cacheKey, result, AIR_CACHE_TTL_SEC).catch(() => {});
  return result;
}
