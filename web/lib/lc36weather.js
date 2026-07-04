/**
 * lc36weather.js — outdoor weather + lightning + daylight for Launch Complex 36.
 *
 * Feeds the morning report with what the crew actually needs before a day of
 * outdoor switchgear work at the Cape: current conditions, today's highs/rain,
 * lightning risk (Central Florida is the US lightning capital — CAPE plus the
 * forecast weather codes drive the classification), and daylight window.
 *
 * Data: Open-Meteo (free, no API key). Never throws — returns null on any
 * failure so the report degrades to its indoor-only form.
 */

// Launch Complex 36, Cape Canaveral Space Force Station.
const LC36 = { lat: 28.4705, lon: -80.543 };
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// api.weather.gov identifies callers by User-Agent instead of an API key
// (required by NWS's usage policy); no registration needed.
const NWS_UA = "SniffMaster-WeatherBot/1.0 (github.com/becktj90/SniffMaster)";

// NWS's own radar viewer for KMLB (Melbourne, FL — the station that covers
// the Cape). A human-facing page, not a scraped image URL, so it stays valid
// even if NWS's internal tile/image scheme changes. Used as the push
// notification's tap-through target.
export const LC36_RADAR_PAGE = "https://radar.weather.gov/station/kmlb/standard";

/** WMO weather code → short label (shared with the weather-briefing route). */
export function weatherCodeLabel(code) {
  const value = Math.round(Number(code ?? -1));
  if (value === 0) return "Clear";
  if ([1, 2].includes(value)) return "Partly cloudy";
  if (value === 3) return "Overcast";
  if ([45, 48].includes(value)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(value)) return "Drizzle";
  if ([61, 63, 65, 66, 67].includes(value)) return "Rain";
  if ([71, 73, 75, 77].includes(value)) return "Snow";
  if ([80, 81, 82].includes(value)) return "Showers";
  if ([85, 86].includes(value)) return "Snow showers";
  if ([95, 96, 99].includes(value)) return "Thunderstorms";
  return "Weather active";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function windDirLabel(deg) {
  const d = num(deg);
  if (!Number.isFinite(d)) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(d / 45) % 8] || "";
}

/** "2026-07-04T06:28" (already in ET from the API) → "6:28 AM" (ASCII). */
function clockLabel(isoLocal) {
  const m = /T(\d{2}):(\d{2})/.exec(String(isoLocal || ""));
  if (!m) return "";
  let h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${m[2]} ${suffix}`;
}

/**
 * Lightning risk from convective energy + forecast codes.
 * CAPE (J/kg) bands follow the usual convective guidance: <300 minimal,
 * 300–1000 slight, 1000–2500 moderate, >2500 high. A thunderstorm weather
 * code forecast for the day floors the answer at "moderate".
 */
export function lightningRisk(maxCape, dailyCode) {
  const cape = num(maxCape);
  const stormForecast = [95, 96, 99].includes(Math.round(num(dailyCode)));
  let level = "minimal";
  if (cape > 2500) level = "high";
  else if (cape > 1000) level = "moderate";
  else if (cape > 300) level = "slight";
  if (stormForecast && (level === "minimal" || level === "slight")) level = "moderate";
  const capeNote = Number.isFinite(cape) ? ` (CAPE ${Math.round(cape)})` : "";
  return { level, text: `${level}${stormForecast ? ", storms forecast" : ""}${capeNote}` };
}

/**
 * Fetch today's LC-36 outdoor picture. Resolves to
 * { lines: string[], risk: string } or null. GSM-7-safe ASCII throughout.
 */
export async function fetchLc36Weather(timeoutMs = 5000) {
  const params = new URLSearchParams({
    latitude: String(LC36.lat),
    longitude: String(LC36.lon),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,weather_code",
    hourly: "cape",
    forecast_days: "1",
    timezone: "America/New_York",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
  });

  try {
    const res = await fetch(`${FORECAST_URL}?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const json = await res.json();

    const cur = json?.current || {};
    const daily = json?.daily || {};
    const capes = Array.isArray(json?.hourly?.cape) ? json.hourly.cape.map(num).filter(Number.isFinite) : [];
    const maxCape = capes.length ? Math.max(...capes) : NaN;

    const lines = [];

    const temp = num(cur.temperature_2m);
    const feels = num(cur.apparent_temperature);
    const hum = num(cur.relative_humidity_2m);
    const wind = num(cur.wind_speed_10m);
    if (Number.isFinite(temp)) {
      const bits = [`${weatherCodeLabel(cur.weather_code)}, ${Math.round(temp)}F`];
      if (Number.isFinite(feels) && Math.abs(feels - temp) >= 3) bits.push(`feels ${Math.round(feels)}F`);
      if (Number.isFinite(hum)) bits.push(`humidity ${Math.round(hum)}%`);
      if (Number.isFinite(wind)) bits.push(`wind ${Math.round(wind)} mph ${windDirLabel(cur.wind_direction_10m)}`.trim());
      lines.push(`LC-36 outdoor: ${bits.join(", ")}.`);
    }

    const hi = num(daily.temperature_2m_max?.[0]);
    const lo = num(daily.temperature_2m_min?.[0]);
    const rain = num(daily.precipitation_probability_max?.[0]);
    const risk = lightningRisk(maxCape, daily.weather_code?.[0]);
    const todayBits = [];
    if (Number.isFinite(hi)) todayBits.push(`high ${Math.round(hi)}F`);
    if (Number.isFinite(lo)) todayBits.push(`low ${Math.round(lo)}F`);
    if (Number.isFinite(rain)) todayBits.push(`rain ${Math.round(rain)}%`);
    if (todayBits.length) lines.push(`Today: ${todayBits.join(", ")}. Lightning risk: ${risk.text}.`);
    else lines.push(`Lightning risk: ${risk.text}.`);

    const sunrise = clockLabel(daily.sunrise?.[0]);
    const sunset = clockLabel(daily.sunset?.[0]);
    if (sunrise && sunset) lines.push(`Daylight: ${sunrise} to ${sunset} ET.`);

    return lines.length ? { lines, risk: risk.level } : null;
  } catch (err) {
    console.error("lc36weather: fetch failed:", err?.message || err);
    return null;
  }
}

/**
 * Today's official NWS forecast icon for LC-36 — a real graphic (small PNG)
 * from api.weather.gov's documented, versioned API, not a scraped/guessed
 * image path. Two sequential calls (point -> gridpoint forecast), each capped
 * so a slow/unreachable NWS never meaningfully delays the report.
 * Resolves to { iconUrl, shortForecast } or null on any failure/timeout.
 */
export async function fetchLc36Icon(timeoutMs = 1800) {
  const headers = { "User-Agent": NWS_UA, Accept: "application/geo+json" };
  try {
    const pointsRes = await fetch(`https://api.weather.gov/points/${LC36.lat},${LC36.lon}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!pointsRes.ok) throw new Error(`points ${pointsRes.status}`);
    const points = await pointsRes.json();
    const forecastUrl = points?.properties?.forecast;
    if (typeof forecastUrl !== "string" || !forecastUrl) throw new Error("no forecast url in points response");

    const fcRes = await fetch(forecastUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!fcRes.ok) throw new Error(`forecast ${fcRes.status}`);
    const fc = await fcRes.json();
    const period = fc?.properties?.periods?.[0];
    const iconUrl = typeof period?.icon === "string" ? period.icon : null;
    const shortForecast = typeof period?.shortForecast === "string" ? period.shortForecast : "";

    return iconUrl ? { iconUrl, shortForecast } : null;
  } catch (err) {
    console.error("lc36weather: icon fetch failed:", err?.message || err);
    return null;
  }
}
