import { monthKey } from "./pollen.js";
export const SOLAR_CACHE_TTL_SEC = 30 * 24 * 3600;
export const SOLAR_FAIL_TTL_SEC = 6 * 3600;
export const SOLAR_DEFAULT_MONTHLY_CAP = 30;
export function solarMonthlyCap(env = process.env) { const n = Number(env.SOLAR_MONTHLY_CAP); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SOLAR_DEFAULT_MONTHLY_CAP; }
export function parseSolarInsights(json) {
  const solar = json?.solarPotential;
  if (!solar || !Number.isFinite(Number(solar.maxArrayPanelsCount))) return null;
  const configs = Array.isArray(solar.solarPanelConfigs) ? solar.solarPanelConfigs : [];
  const best = configs.reduce((winner, row) => Number(row?.yearlyEnergyDcKwh || 0) > Number(winner?.yearlyEnergyDcKwh || 0) ? row : winner, null);
  return { source: "Google Solar API", imageryDate: json?.imageryDate ? `${json.imageryDate.year}-${String(json.imageryDate.month).padStart(2, "0")}-${String(json.imageryDate.day).padStart(2, "0")}` : null, maxPanels: Number(solar.maxArrayPanelsCount), maxAreaM2: Number.isFinite(Number(solar.maxArrayAreaMeters2)) ? Math.round(Number(solar.maxArrayAreaMeters2)) : null, maxSunHoursYear: Number.isFinite(Number(solar.maxSunshineHoursPerYear)) ? Math.round(Number(solar.maxSunshineHoursPerYear)) : null, estimatedYearlyKwh: Number.isFinite(Number(best?.yearlyEnergyDcKwh)) ? Math.round(Number(best.yearlyEnergyDcKwh)) : null };
}
export async function fetchGoogleSolar(loc, deps = {}) {
  const env = deps.env || process.env, key = env.GOOGLE_MAPS_API_KEY, lat = Number(loc?.lat), lon = Number(loc?.lon);
  if (!key) return { ok: false, reason: "Google Maps key not configured" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, reason: "No device location yet" };
  const cacheKey = `solar:${lat.toFixed(3)}:${lon.toFixed(3)}`, failKey = `${cacheKey}:fail`;
  try { const hit = await deps.cacheGet?.(cacheKey); if (hit) return { ok: true, cached: true, ...hit }; const failed = await deps.cacheGet?.(failKey); if (failed) return { ok: false, cached: true, reason: failed.reason || "Solar lookup recently failed" }; } catch {}
  if (!deps.incr) return { ok: false, reason: "Solar usage counter unavailable" };
  let used; try { used = await deps.incr(`solar_calls:${monthKey(deps.now)}`, 40 * 24 * 3600); } catch { return { ok: false, reason: "Solar usage counter unavailable" }; }
  const cap = solarMonthlyCap(env); if (used > cap) return { ok: false, reason: `Solar monthly call cap (${cap}) reached` };
  const url = "https://solar.googleapis.com/v1/buildingInsights:findClosest" + `?location.latitude=${encodeURIComponent(lat.toFixed(5))}` + `&location.longitude=${encodeURIComponent(lon.toFixed(5))}` + "&requiredQuality=MEDIUM" + `&key=${encodeURIComponent(key)}`;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
  try { const res = await (deps.fetchImpl || fetch)(url, { signal: ctl.signal }); if (!res.ok) { const reason = `Google Solar returned HTTP ${res.status}`; await deps.cacheSet?.(failKey, { reason }, SOLAR_FAIL_TTL_SEC).catch(() => {}); return { ok: false, reason }; } const parsed = parseSolarInsights(await res.json()); if (!parsed) return { ok: false, reason: "No solar building insight for this location" }; await deps.cacheSet?.(cacheKey, parsed, SOLAR_CACHE_TTL_SEC).catch(() => {}); return { ok: true, ...parsed }; } catch (err) { const reason = err?.name === "AbortError" ? "Google Solar timed out" : "Google Solar request failed"; await deps.cacheSet?.(failKey, { reason }, SOLAR_FAIL_TTL_SEC).catch(() => {}); return { ok: false, reason }; } finally { clearTimeout(timer); }
}
