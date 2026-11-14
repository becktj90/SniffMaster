/**
 * outdoor.js — free, keyless outdoor context from Open-Meteo.
 *
 *  - forecast API  : current temperature, humidity, dew point, rain
 *  - air-quality API: PM2.5/PM10, gases, dust, UV, US AQI, and (Europe only,
 *    in season) alder/birch/grass/mugwort/olive/ragweed pollen counts
 *
 * Results are cached ~15 min by the caller. When Open-Meteo has no pollen
 * values for the location (e.g. North America), callers fall back to the
 * capped Google Pollen API in pollen.js.
 */

const POLLEN_FIELDS = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];

const n = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function getJson(url, fetchImpl, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Open-Meteo pollen grains/m³ → coarse level (matches EAN-style bands loosely). */
export function pollenLevel(grains) {
  if (!Number.isFinite(grains)) return null;
  if (grains < 10) return "Low";
  if (grains < 50) return "Moderate";
  if (grains < 200) return "High";
  return "Very high";
}

export function parseOpenMeteoPollen(current) {
  if (!current) return null;
  const items = POLLEN_FIELDS.map((f) => ({
    code: f.replace("_pollen", "").toUpperCase(),
    name: f.replace("_pollen", "").replace(/^./, (c) => c.toUpperCase()),
    grains: n(current[f]),
  })).filter((i) => i.grains !== null);
  if (!items.length) return null;
  items.forEach((i) => (i.category = pollenLevel(i.grains)));
  return {
    source: "Open-Meteo (CAMS Europe)",
    scale: "grains/m3",
    types: [],
    plants: items.sort((a, b) => b.grains - a.grains),
    tips: [],
  };
}

/**
 * @returns {Promise<{outdoor: object|null, pollen: object|null}>}
 */
export async function fetchOutdoor({ lat, lon }, fetchImpl = fetch) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { outdoor: null, pollen: null };
  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`;
  const [wx, aq] = await Promise.all([
    getJson(
      `https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,relative_humidity_2m,dew_point_2m,rain,precipitation`,
      fetchImpl
    ),
    getJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,dust,uv_index,${POLLEN_FIELDS.join(",")}`,
      fetchImpl
    ),
  ]);
  if (!wx && !aq) return { outdoor: null, pollen: null };
  const w = wx?.current || {};
  const a = aq?.current || {};
  const outdoor = {
    tempC: n(w.temperature_2m),
    humidity: n(w.relative_humidity_2m),
    dewPointC: n(w.dew_point_2m),
    rainMm: n(w.rain) ?? n(w.precipitation),
    pm25: n(a.pm2_5),
    pm10: n(a.pm10),
    usAqi: n(a.us_aqi),
    o3: n(a.ozone),
    no2: n(a.nitrogen_dioxide),
    so2: n(a.sulphur_dioxide),
    co: n(a.carbon_monoxide),
    dust: n(a.dust),
    uvIndex: n(a.uv_index),
  };
  return { outdoor, pollen: parseOpenMeteoPollen(a) };
}
