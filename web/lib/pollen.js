/**
 * pollen.js — outdoor pollen via the Google Pollen API, with hard cost guards.
 *
 * The Google Maps Platform Pollen API is pay-as-you-go beyond a free monthly
 * allowance, so this module is deliberately stingy:
 *   1. Results are cached per ~11 km cell for 6 h (≈4 calls/day/location).
 *   2. Failures are negative-cached for 30 min so an outage can't loop.
 *   3. A calendar-month counter stops ALL calls once POLLEN_MONTHLY_CAP is hit
 *      (default 300 — far below any free tier). The counter is bumped BEFORE
 *      the request, so a crash can only under-spend, never over-spend.
 *   4. No key configured → no network call at all.
 * The API key comes only from the GOOGLE_POLLEN_API_KEY environment variable
 * and is never logged or returned to the browser.
 *
 * Also set a daily quota cap on the Pollen API in Google Cloud Console — that
 * is the only hard stop on Google's side.
 */

export const POLLEN_CACHE_TTL_SEC = 6 * 3600;
export const POLLEN_FAIL_TTL_SEC = 30 * 60;
export const POLLEN_DEFAULT_MONTHLY_CAP = 300;

export function monthlyCap(env = process.env) {
  const n = Number(env.POLLEN_MONTHLY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : POLLEN_DEFAULT_MONTHLY_CAP;
}

export function monthKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Parse a Google Pollen forecast:lookup response into a small summary. */
export function parseGooglePollen(json) {
  const day = Array.isArray(json?.dailyInfo) ? json.dailyInfo[0] : null;
  if (!day) return null;
  const idx = (o) => ({
    value: Number.isFinite(Number(o?.indexInfo?.value)) ? Number(o.indexInfo.value) : null,
    category: o?.indexInfo?.category || null,
  });
  const types = (day.pollenTypeInfo || []).map((t) => ({
    code: t.code,
    name: t.displayName || t.code,
    inSeason: Boolean(t.inSeason),
    ...idx(t),
  }));
  const plants = (day.plantInfo || [])
    .map((p) => ({ code: p.code, name: p.displayName || p.code, inSeason: Boolean(p.inSeason), ...idx(p) }))
    .filter((p) => p.value !== null && p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const tips = (day.pollenTypeInfo || []).flatMap((t) => t.healthRecommendations || []).slice(0, 2);
  const d = day.date;
  return {
    source: "Google Pollen API",
    scale: "Universal Pollen Index 0-5",
    date: d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null,
    types,
    plants,
    tips,
  };
}

/**
 * @param {{lat:number, lon:number}} loc
 * @param {{
 *   env?: object, now?: number, fetchImpl?: typeof fetch,
 *   cacheGet?: (k:string)=>Promise<any>, cacheSet?: (k:string,v:any,ttl:number)=>Promise<void>,
 *   incr?: (k:string, ttl:number)=>Promise<number>,
 * }} [deps]
 * @returns {Promise<{ok:boolean, reason?:string, cached?:boolean} & object>}
 */
export async function fetchGooglePollen(loc, deps = {}) {
  const env = deps.env || process.env;
  const key = env.GOOGLE_POLLEN_API_KEY;
  if (!key) return { ok: false, reason: "Pollen API key not configured" };

  const lat = Number(loc?.lat);
  const lon = Number(loc?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ok: false, reason: "No device location yet" };
  }

  const cacheKey = `pollen:${lat.toFixed(1)}:${lon.toFixed(1)}`;
  const failKey = `${cacheKey}:fail`;
  const now = deps.now ?? Date.now();

  try {
    if (deps.cacheGet) {
      const hit = await deps.cacheGet(cacheKey);
      if (hit) return { ok: true, cached: true, ...hit };
      const failed = await deps.cacheGet(failKey);
      if (failed) return { ok: false, reason: failed.reason || "Pollen lookup recently failed", cached: true };
    }
  } catch {
    /* cache is best-effort */
  }

  // Hard monthly cap — checked BEFORE spending a call.
  const cap = monthlyCap(env);
  if (deps.incr) {
    let used;
    try {
      used = await deps.incr(`pollen_calls:${monthKey(now)}`, 40 * 24 * 3600);
    } catch {
      // If we can't count calls we can't prove we're under the cap: don't call.
      return { ok: false, reason: "Pollen usage counter unavailable" };
    }
    if (used > cap) return { ok: false, reason: `Pollen monthly call cap (${cap}) reached` };
  } else {
    return { ok: false, reason: "Pollen usage counter unavailable" };
  }

  const url =
    "https://pollen.googleapis.com/v1/forecast:lookup" +
    `?key=${encodeURIComponent(key)}` +
    `&location.latitude=${encodeURIComponent(lat.toFixed(4))}` +
    `&location.longitude=${encodeURIComponent(lon.toFixed(4))}` +
    "&days=1&plantsDescription=false&languageCode=en";

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await (deps.fetchImpl || fetch)(url, { signal: ctl.signal });
    if (!res.ok) {
      // Status only — never log the URL (it contains the key).
      const reason = `Pollen API returned HTTP ${res.status}`;
      if (deps.cacheSet) await deps.cacheSet(failKey, { reason }, POLLEN_FAIL_TTL_SEC).catch(() => {});
      return { ok: false, reason };
    }
    const parsed = parseGooglePollen(await res.json());
    if (!parsed) {
      const reason = "No pollen data for this location";
      if (deps.cacheSet) await deps.cacheSet(failKey, { reason }, POLLEN_FAIL_TTL_SEC).catch(() => {});
      return { ok: false, reason };
    }
    if (deps.cacheSet) await deps.cacheSet(cacheKey, parsed, POLLEN_CACHE_TTL_SEC).catch(() => {});
    return { ok: true, ...parsed };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "Pollen API timed out" : "Pollen API request failed";
    if (deps.cacheSet) await deps.cacheSet(failKey, { reason }, POLLEN_FAIL_TTL_SEC).catch(() => {});
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
