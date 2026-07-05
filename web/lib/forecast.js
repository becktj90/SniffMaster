/**
 * forecast.js — day-ahead weather + natural-lighting outlook for LC-36
 * (Launch Complex 36, Cape Canaveral Space Force Station).
 *
 * The daily personnel report is anchored to the work site, so this uses FIXED
 * site coordinates — deliberately independent of the device GPS logic that the
 * dashboard's weather card uses (a sensor riding in a truck shouldn't move the
 * site forecast).
 *
 * Data source: Open-Meteo (no API key). Returns null on any failure so report
 * generation can never be blocked by a weather outage. All strings returned
 * here may be embedded in SMS bodies — keep them GSM-7-safe ASCII.
 *
 * Cached in Redis for CACHE_TTL_SEC: the daily cron only needs one fetch a
 * day, but real-time alerts (api/update.js) also want the outlook without
 * adding Open-Meteo's round-trip latency to every device POST — a cache hit
 * there is a plain Redis read.
 */

import { isRedisConfigured } from "./store.js";
import { Redis } from "@upstash/redis";

const LC36 = {
  name: "LC-36",
  lat: 28.4707,
  lon: -80.5405,
  timezone: "America/New_York",
};

const CACHE_KEY = "sniffmaster:lc36-outlook";
const CACHE_TTL_SEC = 1800; // 30 min — outlook doesn't shift fast enough to need fresher

// WMO weather codes → short human label (ASCII only).
const WEATHER_CODE_LABELS = [
  [95, "Thunderstorms"],
  [85, "Snow showers"],
  [80, "Rain showers"],
  [71, "Snow"],
  [61, "Rain"],
  [51, "Drizzle"],
  [45, "Fog"],
  [3, "Overcast"],
  [2, "Partly cloudy"],
  [1, "Mostly clear"],
  [0, "Clear"],
];

export function weatherCodeLabel(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return "Unknown";
  for (const [min, label] of WEATHER_CODE_LABELS) {
    if (c >= min) return label;
  }
  return "Unknown";
}

/** Bucket average daytime cloud cover into a work-lighting description. */
export function lightingLabelFromCloudCover(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct < 25) return "bright sun most of the day";
  if (pct < 50) return "mostly sunny";
  if (pct < 75) return "mixed sun and clouds";
  return "overcast, dim natural light";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "HH:MM" local clock time from an Open-Meteo ISO local string. */
function clockOf(isoLocal) {
  const m = /T(\d{2}:\d{2})/.exec(String(isoLocal || ""));
  return m ? m[1] : null;
}

/**
 * Fetch today's outlook for LC-36.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<null | {
 *   site:string, lat:number, lon:number, date:string,
 *   condition:string, highF:number|null, lowF:number|null,
 *   precipChance:number|null, windMph:number|null, gustMph:number|null,
 *   thunder:boolean,
 *   sunrise:string|null, sunset:string|null, daylightHours:number|null,
 *   cloudCoverPct:number|null, lightingLabel:string|null,
 *   fetchedAt:number
 * }>}
 */
export async function fetchLc36OutlookLive(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 6000;
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${LC36.lat}&longitude=${LC36.lon}` +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,weather_code,sunrise,sunset,daylight_duration" +
    "&hourly=cloud_cover,weather_code" +
    `&timezone=${encodeURIComponent(LC36.timezone)}` +
    "&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph";

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const data = await res.json();

    const d = data?.daily || {};
    const date = Array.isArray(d.time) ? d.time[0] : null;
    const code = num(d.weather_code?.[0]);
    const highF = num(d.temperature_2m_max?.[0]);
    const lowF = num(d.temperature_2m_min?.[0]);
    const precipChance = num(d.precipitation_probability_max?.[0]);
    const windMph = num(d.wind_speed_10m_max?.[0]);
    const gustMph = num(d.wind_gusts_10m_max?.[0]);
    const sunrise = clockOf(d.sunrise?.[0]);
    const sunset = clockOf(d.sunset?.[0]);
    const daylightSec = num(d.daylight_duration?.[0]);
    const daylightHours = daylightSec !== null ? Math.round((daylightSec / 3600) * 10) / 10 : null;

    // Average cloud cover across working daylight hours (07:00–18:00 local)
    // — that IS the natural-lighting forecast for the crew.
    const hours = Array.isArray(data?.hourly?.time) ? data.hourly.time : [];
    const clouds = Array.isArray(data?.hourly?.cloud_cover) ? data.hourly.cloud_cover : [];
    const hourlyCodes = Array.isArray(data?.hourly?.weather_code) ? data.hourly.weather_code : [];
    const daytime = [];
    let hourlyThunder = false;
    hours.forEach((t, i) => {
      const hh = Number(/T(\d{2}):/.exec(String(t || ""))?.[1]);
      if (!Number.isFinite(hh) || hh < 7 || hh >= 18) return;
      const cc = num(clouds[i]);
      if (cc !== null) daytime.push(cc);
      const hc = num(hourlyCodes[i]);
      if (hc !== null && hc >= 95) hourlyThunder = true;
    });
    const cloudCoverPct = daytime.length
      ? Math.round(daytime.reduce((a, b) => a + b, 0) / daytime.length)
      : null;

    const thunder = (code !== null && code >= 95) || hourlyThunder;

    return {
      site: LC36.name,
      lat: LC36.lat,
      lon: LC36.lon,
      date,
      condition: weatherCodeLabel(code),
      highF,
      lowF,
      precipChance,
      windMph,
      gustMph,
      thunder,
      sunrise,
      sunset,
      daylightHours,
      cloudCoverPct,
      lightingLabel: lightingLabelFromCloudCover(cloudCoverPct),
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error("forecast: LC-36 outlook fetch failed:", err?.message || err);
    return null;
  }
}

/**
 * Cache-through fetch of the LC-36 outlook (see CACHE_TTL_SEC). Falls back to
 * an uncached live fetch when Redis isn't configured, so local dev and any
 * misconfigured deploy still get an outlook rather than nothing.
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function fetchLc36Outlook(opts = {}) {
  if (!isRedisConfigured()) return fetchLc36OutlookLive(opts);
  try {
    const redis = Redis.fromEnv();
    const raw = await redis.get(CACHE_KEY);
    if (raw) return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error("forecast: outlook cache read failed:", err?.message || err);
  }
  const fresh = await fetchLc36OutlookLive(opts);
  if (fresh) {
    try {
      const redis = Redis.fromEnv();
      await redis.set(CACHE_KEY, JSON.stringify(fresh), { ex: CACHE_TTL_SEC });
    } catch (err) {
      console.error("forecast: outlook cache write failed:", err?.message || err);
    }
  }
  return fresh;
}

/**
 * 1–2 short ASCII lines for the SMS report. Returns "" when no outlook —
 * better silent than wrong.
 */
export function outlookToSmsLines(o) {
  if (!o || typeof o !== "object") return "";
  const bits = [];
  if (Number.isFinite(o.highF) && Number.isFinite(o.lowF)) bits.push(`${Math.round(o.highF)}F/${Math.round(o.lowF)}F`);
  const cond = o.condition && o.condition !== "Unknown" ? o.condition.toLowerCase() : "";
  // Skip the condition word when the precip % already tells the same story
  // ("rain, rain 41%" reads badly).
  const precipShown = Number.isFinite(o.precipChance);
  if (cond && !(precipShown && /rain|drizzle|shower/.test(cond))) bits.push(cond);
  if (precipShown) bits.push(`rain ${Math.round(o.precipChance)}%`);
  if (Number.isFinite(o.windMph)) bits.push(`wind ${Math.round(o.windMph)} mph`);
  const line1 = bits.length ? `${o.site} today: ${bits.join(", ")}.` : "";

  const lightBits = [];
  if (o.sunrise && o.sunset) lightBits.push(`Sun ${o.sunrise}-${o.sunset}`);
  if (Number.isFinite(o.daylightHours)) lightBits.push(`${o.daylightHours}h daylight`);
  if (o.lightingLabel) lightBits.push(o.lightingLabel);
  let line2 = lightBits.length ? `${lightBits.join(", ")}.` : "";
  if (o.thunder) line2 = `${line2}${line2 ? " " : ""}Thunderstorm risk - plan outdoor work early.`;

  return [line1, line2].filter(Boolean).join("\n");
}
