/**
 * googleEnv.js — compact outdoor context for the device.
 *
 * Google Maps Platform (Pollen, Air Quality, Weather, Geolocation) is called
 * only from this server. The API key never goes into a response or a log line.
 * Open-Meteo fills weather and air quality when Google is unset or errors.
 * Pollen is omitted on that fallback. The daily LC-36 forecast is not this module.
 *
 * Pollen calls go through pollen.js so the monthly cap still applies.
 * GOOGLE_MAPS_API_KEY is used for weather, air quality, geolocation, and
 * reverse geocoding. It is also accepted as the pollen key when
 * GOOGLE_POLLEN_API_KEY is unset.
 */

import { fetchGooglePollen } from "./pollen.js";
import { fetchOutdoor } from "./outdoor.js";

export const ENV_TTL_SEC = 1800;
export const ENV_MAX_BYTES = 1100;
const DEFAULT_LAT = 28.4889;
const DEFAULT_LON = -80.5778;
const GEOHASH_BASE = "0123456789bcdefghjkmnpqrstuvwxyz";

const MW = { co: 28.01, no2: 46.01, o3: 48.0, so2: 64.07 };

export function geohash(lat, lon, precision = 6) {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let hash = "", bits = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; minLon = mid; }
      else { ch <<= 1; maxLon = mid; }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; minLat = mid; }
      else { ch <<= 1; maxLat = mid; }
    }
    even = !even;
    if (++bits === 5) {
      hash += GEOHASH_BASE[ch];
      bits = 0;
      ch = 0;
    }
  }
  return hash;
}

export function cleanWifi(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const ap of list) {
    if (!ap || typeof ap !== "object" || out.length >= 8) continue;
    const mac = String(ap.mac || ap.macAddress || "").trim().toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
    const item = { macAddress: mac };
    const rssi = Number(ap.rssi ?? ap.signalStrength);
    const channel = Number(ap.channel);
    if (Number.isFinite(rssi)) item.signalStrength = Math.round(rssi);
    if (Number.isFinite(channel)) item.channel = Math.round(channel);
    out.push(item);
  }
  return out.slice(0, 8);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function finite(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

export function ugPerM3(code, concentration) {
  const value = finite(concentration?.value);
  if (value === null) return null;
  const units = String(concentration?.units || "");
  if (code === "pm25" || code === "pm10" || units === "MICROGRAMS_PER_CUBIC_METER") return round1(value);
  const mw = MW[code];
  if (!mw) return null;
  let ppb = null;
  if (units === "PARTS_PER_BILLION") ppb = value;
  else if (units === "PARTS_PER_MILLION") ppb = value * 1000;
  if (ppb === null) return null;
  return round1((ppb * mw) / 24.45);
}

export function toFahrenheit(temp) {
  const degrees = finite(temp?.degrees);
  if (degrees === null) return null;
  const unit = String(temp?.unit || "FAHRENHEIT").toUpperCase();
  if (unit.startsWith("CEL")) return Math.round((degrees * 9) / 5 + 32);
  return Math.round(degrees);
}

export function toMph(speed) {
  const value = finite(speed?.value);
  if (value === null) return null;
  const unit = String(speed?.unit || "").toUpperCase();
  if (unit.includes("KILO")) return Math.round(value * 0.621371);
  if (unit.includes("METER_PER_SECOND") || unit === "METERS_PER_SECOND") return Math.round(value * 2.23694);
  return Math.round(value);
}

function compass(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const d = finite(deg);
  if (d === null) return "";
  return dirs[Math.round(((d % 360) + 360) % 360 / 45) % 8];
}

const CARDINAL = {
  NORTH: "N", NORTH_NORTHEAST: "N", NORTH_EAST: "NE", NORTHEAST: "NE",
  EAST_NORTHEAST: "E", EAST: "E", EAST_SOUTHEAST: "E", SOUTH_EAST: "SE", SOUTHEAST: "SE",
  SOUTH_SOUTHEAST: "S", SOUTH: "S", SOUTH_SOUTHWEST: "S", SOUTH_WEST: "SW", SOUTHWEST: "SW",
  WEST_SOUTHWEST: "W", WEST: "W", WEST_NORTHWEST: "W", NORTH_WEST: "NW", NORTHWEST: "NW",
  NORTH_NORTHWEST: "N",
};

export function shortCategory(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Sensitive";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Bad";
  return "Hazardous";
}

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function wmoText(code) {
  const c = Number(code);
  if (c === 0) return "Clear";
  if (c === 1) return "Mostly clear";
  if (c === 2) return "Partly cloudy";
  if (c === 3) return "Overcast";
  if (c === 45 || c === 48) return "Fog";
  if (c >= 51 && c <= 57) return "Drizzle";
  if (c === 61 || c === 63) return "Rain";
  if (c === 65) return "Heavy rain";
  if (c >= 71 && c <= 77) return "Snow";
  if (c >= 80 && c <= 82) return "Rain showers";
  if (c >= 95) return "Thunderstorm";
  return "Unknown";
}

async function getJson(url, fetchImpl, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, fetchImpl, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function parseGoogleAir(json) {
  const indexes = Array.isArray(json?.indexes) ? json.indexes : [];
  const epa = indexes.find((i) => i?.code === "usa_epa");
  const uaqi = indexes.find((i) => i?.code === "uaqi");
  const usAqi = finite(epa?.aqi);
  if (usAqi === null || usAqi < 0 || usAqi > 500) return null;
  const pollutants = Array.isArray(json?.pollutants) ? json.pollutants : [];
  const conc = (code) => {
    const row = pollutants.find((p) => p?.code === code);
    return row ? ugPerM3(code, row.concentration) : null;
  };
  return {
    usAqi: Math.round(usAqi),
    cat: shortCategory(usAqi),
    uaqi: finite(uaqi?.aqi) === null ? null : Math.round(uaqi.aqi),
    dom: String(epa?.dominantPollutant || "").slice(0, 8),
    pm25: conc("pm25"),
    pm10: conc("pm10"),
    o3: conc("o3"),
    no2: conc("no2"),
    so2: conc("so2"),
    co: conc("co"),
  };
}

export function parseGoogleWeather(json) {
  const tempF = toFahrenheit(json?.temperature);
  if (tempF === null) return null;
  const wind = json?.wind || {};
  const cardinal = CARDINAL[String(wind.direction?.cardinal || "").toUpperCase()] || compass(wind.direction?.degrees);
  const air = json?.airPressure || {};
  let press = finite(air.meanSeaLevelMillibars);
  if (press === null) {
    const inHg = finite(air.meanSeaLevelInchesOfMercury ?? air.inchesOfMercury);
    if (inHg !== null) press = inHg * 33.8639;
  }
  const vis = json?.visibility || {};
  let visMi = finite(vis.distance);
  if (visMi !== null && String(vis.unit || "").toUpperCase().startsWith("KILO")) visMi = Math.round(visMi * 0.621371);
  else if (visMi !== null) visMi = Math.round(visMi);
  return {
    cond: clip(json?.weatherCondition?.description?.text || json?.weatherCondition?.type || "Unknown", 21),
    tempF,
    feelsF: toFahrenheit(json?.feelsLikeTemperature),
    dewF: toFahrenheit(json?.dewPoint),
    heatF: toFahrenheit(json?.heatIndex),
    rh: finite(json?.relativeHumidity) === null ? null : Math.round(json.relativeHumidity),
    windMph: toMph(wind.speed),
    gustMph: toMph(wind.gust),
    windDir: cardinal || "",
    precipPct: finite(json?.precipitation?.probability?.percent),
    thunderPct: finite(json?.thunderstormProbability),
    uv: finite(json?.uvIndex) === null ? null : Math.round(json.uvIndex),
    cloudPct: finite(json?.cloudCover) === null ? null : Math.round(json.cloudCover),
    pressHpa: press === null ? null : round1(press),
    visMi,
  };
}

function dropNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

export function parsePollenSummary(parsed) {
  if (!parsed || parsed.ok === false) return null;
  const types = Array.isArray(parsed.types) ? parsed.types : [];
  const idx = (code) => {
    const row = types.find((t) => String(t.code || "").toUpperCase() === code);
    const v = Number(row?.value);
    return Number.isFinite(v) ? Math.max(0, Math.min(5, Math.round(v))) : 0;
  };
  if (!types.length) return null;
  const plants = (Array.isArray(parsed.plants) ? parsed.plants : [])
    .filter((p) => Number.isFinite(Number(p.value)));
  const top = plants.find((p) => p.inSeason) || plants[0];
  const summary = {
    tree: idx("TREE"),
    grass: idx("GRASS"),
    weed: idx("WEED"),
  };
  if (top?.name) {
    summary.top = clip(top.name, 16);
    const topIdx = Number(top.value);
    if (Number.isFinite(topIdx)) summary.topIdx = Math.max(0, Math.min(5, Math.round(topIdx)));
  }
  return summary;
}

async function resolveLocation(input, key, fetchImpl) {
  const wifi = cleanWifi(input.wifi);
  const lat = finite(input.lat);
  const lon = finite(input.lon);
  const hasFix = lat !== null && lon !== null && (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001);
  if (key && wifi.length >= 2) {
    const url = `https://www.googleapis.com/geolocation/v1/geolocate?key=${encodeURIComponent(key)}`;
    const res = await postJson(url, { considerIp: false, wifiAccessPoints: wifi }, fetchImpl);
    const glat = finite(res.json?.location?.lat);
    const glon = finite(res.json?.location?.lng);
    if (res.ok && glat !== null && glon !== null) {
      return {
        lat: glat,
        lon: glon,
        accM: finite(res.json?.accuracy) === null ? null : Math.round(res.json.accuracy),
        source: "wifi",
      };
    }
  }
  if (hasFix) return { lat, lon, accM: null, source: "coords" };
  return { lat: DEFAULT_LAT, lon: DEFAULT_LON, accM: null, source: "default" };
}

async function reverseLocality(loc, key, fetchImpl) {
  if (!key || loc.source !== "wifi") return null;
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?latlng=${encodeURIComponent(`${loc.lat},${loc.lon}`)}` +
    `&result_type=locality&key=${encodeURIComponent(key)}`;
  const res = await getJson(url, fetchImpl, 4000);
  if (!res.ok) return null;
  const comps = res.json?.results?.[0]?.address_components;
  if (!Array.isArray(comps)) return null;
  const city = comps.find((c) => Array.isArray(c.types) && c.types.includes("locality"));
  return city?.long_name ? clip(city.long_name, 24) : null;
}

async function googleWeather(loc, key, fetchImpl) {
  const url =
    "https://weather.googleapis.com/v1/currentConditions:lookup" +
    `?key=${encodeURIComponent(key)}` +
    `&location.latitude=${loc.lat}&location.longitude=${loc.lon}` +
    "&unitsSystem=IMPERIAL&languageCode=en";
  const res = await getJson(url, fetchImpl);
  if (!res.ok) return null;
  return parseGoogleWeather(res.json);
}

async function googleAir(loc, key, fetchImpl) {
  const url = `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${encodeURIComponent(key)}`;
  const res = await postJson(url, {
    location: { latitude: loc.lat, longitude: loc.lon },
    extraComputations: ["POLLUTANT_CONCENTRATION", "LOCAL_AQI", "DOMINANT_POLLUTANT_CONCENTRATION"],
    customLocalAqis: [{ regionCode: "us", aqi: "usa_epa" }],
    universalAqi: true,
    languageCode: "en",
  }, fetchImpl);
  if (!res.ok) return null;
  return parseGoogleAir(res.json);
}

async function openMeteoBundle(loc, fetchImpl) {
  const q = `latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}`;
  const [wxRes, aqRes] = await Promise.all([
    getJson(
      "https://api.open-meteo.com/v1/forecast?" + q +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code," +
        "wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover" +
        "&temperature_unit=fahrenheit&wind_speed_unit=mph",
      fetchImpl
    ),
    getJson(
      "https://air-quality-api.open-meteo.com/v1/air-quality?" + q +
        "&current=us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,ozone,sulphur_dioxide,uv_index",
      fetchImpl
    ),
  ]);
  // fetchOutdoor is the dashboard's keyless path. Use it only to confirm the
  // module import stays the fallback source of pollutant numbers when the
  // richer current= request above fails.
  let outdoor = null;
  if (!aqRes.ok || !wxRes.ok) {
    const basic = await fetchOutdoor({ lat: loc.lat, lon: loc.lon }, fetchImpl);
    outdoor = basic.outdoor;
  }
  const w = wxRes.json?.current || {};
  const a = aqRes.json?.current || {};
  const tempF = finite(w.temperature_2m) ?? (outdoor?.tempC === null || outdoor?.tempC === undefined ? null : Math.round(outdoor.tempC * 9 / 5 + 32));
  const usAqi = finite(a.us_aqi) ?? finite(outdoor?.usAqi);
  if (tempF === null || usAqi === null) return null;
  const aqi = Math.round(usAqi);
  return {
    wx: dropNulls({
      cond: clip(wmoText(w.weather_code), 21),
      tempF: Math.round(tempF),
      feelsF: finite(w.apparent_temperature) === null ? null : Math.round(w.apparent_temperature),
      dewF: finite(w.dew_point_2m) === null ? null : Math.round(w.dew_point_2m),
      rh: finite(w.relative_humidity_2m) === null ? (finite(outdoor?.humidity) === null ? null : Math.round(outdoor.humidity)) : Math.round(w.relative_humidity_2m),
      windMph: finite(w.wind_speed_10m) === null ? null : Math.round(w.wind_speed_10m),
      gustMph: finite(w.wind_gusts_10m) === null ? null : Math.round(w.wind_gusts_10m),
      windDir: compass(w.wind_direction_10m),
      cloudPct: finite(w.cloud_cover) === null ? null : Math.round(w.cloud_cover),
      pressHpa: finite(w.surface_pressure) === null ? null : round1(w.surface_pressure),
    }),
    aq: dropNulls({
      usAqi: aqi,
      cat: shortCategory(aqi),
      pm25: finite(a.pm2_5) ?? finite(outdoor?.pm25),
      pm10: finite(a.pm10) ?? finite(outdoor?.pm10),
      o3: finite(a.ozone) ?? finite(outdoor?.o3),
      no2: finite(a.nitrogen_dioxide) ?? finite(outdoor?.no2),
      so2: finite(a.sulphur_dioxide) ?? finite(outdoor?.so2),
      co: finite(a.carbon_monoxide) ?? finite(outdoor?.co),
      uv: finite(a.uv_index) === null ? null : Math.round(a.uv_index),
    }),
  };
}

function pack(loc, source, wx, aq, pollen, label) {
  const body = {
    ok: true,
    source,
    ttlSec: ENV_TTL_SEC,
    loc: dropNulls({
      lat: round4(loc.lat),
      lon: round4(loc.lon),
      accM: loc.accM,
      source: loc.source,
      label,
    }),
    wx: dropNulls(wx),
    aq: dropNulls(aq),
  };
  if (pollen) body.pollen = pollen;
  if (JSON.stringify(body).length > ENV_MAX_BYTES) {
    delete body.loc.label;
    if (body.pollen) delete body.pollen.top;
  }
  return body;
}

async function pollenFor(loc, env, deps) {
  const pollenKey = env.GOOGLE_POLLEN_API_KEY || env.GOOGLE_MAPS_API_KEY;
  if (!pollenKey || !deps.incr) return null;
  const parsed = await fetchGooglePollen(
    { lat: loc.lat, lon: loc.lon },
    {
      env: { ...env, GOOGLE_POLLEN_API_KEY: pollenKey },
      now: deps.now,
      fetchImpl: deps.fetchImpl,
      cacheGet: deps.cacheGet,
      cacheSet: deps.cacheSet,
      incr: deps.incr,
    }
  );
  if (!parsed?.ok) return null;
  return parsePollenSummary(parsed);
}

/**
 * @param {{lat?:number, lon?:number, wifi?:object[]}} [input]
 * @param {{env?:object, fetchImpl?:typeof fetch, cacheGet?:Function, cacheSet?:Function, incr?:Function, now?:number}} [deps]
 */
export async function lookupEnvironment(input = {}, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || fetch;
  const key = String(env.GOOGLE_MAPS_API_KEY || "").trim();
  const loc = await resolveLocation(input, key, fetchImpl);
  const cacheKey = `env:v1:${loc.source}:${geohash(loc.lat, loc.lon)}`;

  if (deps.cacheGet) {
    try {
      const hit = await deps.cacheGet(cacheKey);
      if (hit && hit.ok) return hit;
    } catch {
      /* cache is best-effort */
    }
  }

  let source = "google";
  let wx = null;
  let aq = null;
  let pollen = null;
  if (key) {
    const [weather, air, pollenRaw] = await Promise.all([
      googleWeather(loc, key, fetchImpl),
      googleAir(loc, key, fetchImpl),
      pollenFor(loc, env, { ...deps, fetchImpl }),
    ]);
    if (weather && air) {
      wx = dropNulls(weather);
      aq = dropNulls(air);
      pollen = pollenRaw;
    }
  }
  if (!wx || !aq) {
    const fallback = await openMeteoBundle(loc, fetchImpl);
    if (!fallback) return { ok: false };
    wx = fallback.wx;
    aq = fallback.aq;
    pollen = null;
    source = "open-meteo";
  }

  let label = null;
  if (source === "google" && loc.source === "wifi") {
    label = await reverseLocality(loc, key, fetchImpl);
  }
  const body = pack(loc, source, wx, aq, pollen, label);
  if (deps.cacheSet && body.ok) {
    try { await deps.cacheSet(cacheKey, body, ENV_TTL_SEC); } catch { /* ignore */ }
  }
  return body;
}
