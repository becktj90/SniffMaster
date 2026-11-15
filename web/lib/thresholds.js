/**
 * thresholds.js — shared reading normalization + breach evaluation.
 *
 * The device pipeline historically stored Fahrenheit (`tempF`) plus `gasR` /
 * `pressHpa`, while newer BME688 firmware may post Celsius `temperature`,
 * `gas_resistance`, and `pressure`. Everything here reads BOTH conventions and
 * normalizes to canonical units (temperature in °C) before comparing.
 *
 * Thresholds target conditions for personnel working in the monitored room:
 *   - Humidity > 60 %RH  → heat-stress/comfort risk and condensation on equipment
 *   - Temperature > 40 °C → heat-stress risk / environmental-control failure
 *   - Sudden gas-resistance drop OR poor IAQ → smoke / fumes exposure
 *   - CO2 above limit → ventilation falling behind occupancy
 *
 * The humidity/temperature/CO2 limits are OWNER-ADJUSTABLE at runtime: the settings
 * endpoint stores overrides in Redis, and callers merge them via
 * getEffectiveThresholds() before evaluating. THRESHOLDS below are the built-in
 * defaults / fallback.
 *
 * NOTE: These constants are the single source of truth for the backend. The
 * static frontend cannot import this module, so it mirrors the same numbers in
 * app.js and pulls live overrides from /api/settings — keep the defaults in
 * sync if you change anything here.
 */

import { evaluateHomeBreaches } from "./homeAir.js";

export const THRESHOLDS = {
  HUMIDITY_HIGH: 60, // %RH (loosened from 55 — was firing at the ~56% baseline)
  TEMP_HIGH_C: 40, // °C
  IAQ_POOR: 150, // BME688 IAQ index (higher = worse)
  GAS_DROP_RATIO: 0.6, // gasR at/under 60% of baseline = ≥40% sudden drop
  GAS_MIN_BASELINE: 1000, // ignore drop test below this baseline (noise floor, Ohms)
  CO2_HIGH: 1000, // ppm — ASHRAE-style indoor-air-quality guidance for occupied office space
  PM25_HIGH: 35, // µg/m³ — only evaluated when the device reports PM2.5 (add-on sensor); EPA 24-h "unhealthy for sensitive groups" edge
};

// Environment presets tailor which readings matter and how they're framed.
// "industrial" (default) watches an active work area with equipment and crews
// (condensation, heat, fumes); "office" watches a normally-occupied workspace
// where CO2/ventilation and comfort for people matter most. "home" watches a
// residence: particulate, mold/dust-mite humidity exposure, dry air, VOC and
// ventilation (see lib/homeAir.js and the dashboard's Home tab).
export const ENVIRONMENT_TYPES = ["industrial", "office", "home"];
export const DEFAULT_ENVIRONMENT_TYPE = "industrial";

// Legacy aliases from older stored settings — normalize silently so existing
// Redis blobs keep working without a migration.
const ENVIRONMENT_ALIASES = { construction: "industrial" };

export function normalizeEnvironmentType(value) {
  const v = String(value || "").trim().toLowerCase();
  const mapped = ENVIRONMENT_ALIASES[v] || v;
  return ENVIRONMENT_TYPES.includes(mapped) ? mapped : DEFAULT_ENVIRONMENT_TYPE;
}

/** True when the value is a current environment type or a known legacy alias. */
export function isKnownEnvironmentType(value) {
  const v = String(value || "").trim().toLowerCase();
  return ENVIRONMENT_TYPES.includes(ENVIRONMENT_ALIASES[v] || v);
}

// Guardrails for owner-supplied overrides — a fat-fingered value must never
// disable safety monitoring (e.g. humidity set to 500 would never alarm).
// The settings endpoint has no password gate (anyone with the dashboard URL
// can adjust these), so these ranges are the only thing standing between a
// bad input and monitoring going dark — keep every adjustable field clamped.
export const THRESHOLD_LIMITS = {
  HUMIDITY_HIGH: { min: 40, max: 90 },
  TEMP_HIGH_C: { min: 25, max: 70 },
  CO2_HIGH: { min: 600, max: 2000 },
  IAQ_POOR: { min: 50, max: 300 },
  PM25_HIGH: { min: 9, max: 150 },
  // Expressed to owners as a % drop (e.g. 40 = "a 40% drop trips the alert"),
  // stored internally as GAS_DROP_RATIO (= 1 - pct/100).
  GAS_DROP_PCT: { min: 20, max: 70 },
};

// Real-time alert re-send cooldown — separate from THRESHOLDS (it paces
// notifications, not a breach condition) but adjustable the same way.
export const DEFAULT_ALERT_COOLDOWN_MIN = 30;
export const ALERT_COOLDOWN_LIMITS = { min: 5, max: 180 };

function clampNum(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge owner overrides onto the built-in defaults, clamped to safe ranges.
 * Unknown/invalid fields are ignored so a partial or malformed settings blob
 * degrades to defaults rather than breaking evaluation.
 * @param {object} [overrides] — e.g. { humidityHigh: 62, tempHighC: 42 }
 * @returns {typeof THRESHOLDS}
 */
export function getEffectiveThresholds(overrides) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const t = { ...THRESHOLDS };
  const hum = Number(o.humidityHigh);
  if (Number.isFinite(hum)) {
    t.HUMIDITY_HIGH = clampNum(hum, THRESHOLD_LIMITS.HUMIDITY_HIGH.min, THRESHOLD_LIMITS.HUMIDITY_HIGH.max);
  }
  const temp = Number(o.tempHighC);
  if (Number.isFinite(temp)) {
    t.TEMP_HIGH_C = clampNum(temp, THRESHOLD_LIMITS.TEMP_HIGH_C.min, THRESHOLD_LIMITS.TEMP_HIGH_C.max);
  }
  const co2 = Number(o.co2High);
  if (Number.isFinite(co2)) {
    t.CO2_HIGH = clampNum(co2, THRESHOLD_LIMITS.CO2_HIGH.min, THRESHOLD_LIMITS.CO2_HIGH.max);
  }
  const iaq = Number(o.iaqPoor);
  if (Number.isFinite(iaq)) {
    t.IAQ_POOR = clampNum(iaq, THRESHOLD_LIMITS.IAQ_POOR.min, THRESHOLD_LIMITS.IAQ_POOR.max);
  }
  const pm25 = Number(o.pm25High);
  if (Number.isFinite(pm25)) {
    t.PM25_HIGH = clampNum(pm25, THRESHOLD_LIMITS.PM25_HIGH.min, THRESHOLD_LIMITS.PM25_HIGH.max);
  }
  const gasDropPct = Number(o.gasDropPct);
  if (Number.isFinite(gasDropPct)) {
    const pct = clampNum(gasDropPct, THRESHOLD_LIMITS.GAS_DROP_PCT.min, THRESHOLD_LIMITS.GAS_DROP_PCT.max);
    t.GAS_DROP_RATIO = 1 - pct / 100;
  }
  return t;
}

/** Resolve the effective environment type ("industrial"/"office"/"home") from stored settings. */
export function getEffectiveEnvironmentType(overrides) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  return normalizeEnvironmentType(o.environmentType);
}

/** Resolve the effective real-time-alert re-send cooldown, in milliseconds. */
export function getEffectiveAlertCooldownMs(overrides) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const min = Number(o.alertCooldownMin);
  const clamped = Number.isFinite(min)
    ? clampNum(min, ALERT_COOLDOWN_LIMITS.min, ALERT_COOLDOWN_LIMITS.max)
    : DEFAULT_ALERT_COOLDOWN_MIN;
  return clamped * 60 * 1000;
}

function num(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fToC(f) {
  return ((f - 32) * 5) / 9;
}

/**
 * Normalize a raw snapshot into canonical fields.
 * Returns numbers where available, otherwise NaN (so callers can skip missing metrics).
 * @param {object} snapshot
 * @returns {{tempC:number, humidity:number, pressHpa:number, gasR:number, iaq:number, receivedAt:number}}
 */
export function normalizeReading(snapshot) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};

  // Temperature: prefer explicit Celsius, then a `tempC`, else convert `tempF`.
  let tempC = num(s.temperature);
  if (!Number.isFinite(tempC)) tempC = num(s.tempC);
  if (!Number.isFinite(tempC)) {
    const tempF = num(s.tempF);
    if (Number.isFinite(tempF)) tempC = fToC(tempF);
  }

  const humidity = num(s.humidity);

  let pressHpa = num(s.pressHpa);
  if (!Number.isFinite(pressHpa)) pressHpa = num(s.pressure);

  let gasR = num(s.gasR);
  if (!Number.isFinite(gasR)) gasR = num(s.gas_resistance);
  if (!Number.isFinite(gasR)) gasR = num(s.gasResistance);

  const iaq = num(s.iaq);
  const co2True = num(s.co2True);
  const co2 = Number.isFinite(co2True) ? co2True : num(s.co2);

  // Optional add-on sensor fields (NaN when the device does not report them).
  const pm25 = num(s.pm25);
  const pm10 = num(s.pm10);
  const hcho = num(s.hcho);

  const receivedAt = num(s.receivedAt, Date.now());

  return { tempC, humidity, pressHpa, gasR, iaq, co2, pm25, pm10, hcho, receivedAt };
}

/**
 * Compute a baseline gas resistance from recent history (median of finite gasR),
 * used to detect sudden drops. Excludes the current reading if the caller passes
 * only prior snapshots.
 * @param {Array<object>} history — raw snapshots (any field convention)
 * @returns {number} median gasR, or NaN if none available
 */
export function baselineGasR(history) {
  if (!Array.isArray(history)) return NaN;
  const values = history
    .map((h) => normalizeReading(h).gasR)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!values.length) return NaN;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Evaluate active threshold breaches for a normalized reading.
 *
 * `message` strings are sent verbatim over SMS, so they intentionally stick to
 * the GSM-7 character set (no degree signs, ohm symbols, or smart dashes) —
 * non-GSM characters force UCS-2 encoding, cutting segments from 160 to 70
 * chars and tripling per-text cost, and some carriers mangle them.
 *
 * @param {ReturnType<normalizeReading>} reading
 * @param {number} [baseGasR] — baseline gas resistance for the sudden-drop test
 * @param {typeof THRESHOLDS} [thresholds] — effective limits (see
 *        getEffectiveThresholds); defaults to the built-in THRESHOLDS.
 * @param {"industrial"|"office"} [environmentType] — tailors wording for the
 *        space (industrial work area vs occupied office).
 * @returns {Array<{key:string, level:"warn"|"crit", label:string, message:string}>}
 */
export function evaluateBreaches(reading, baseGasR, thresholds = THRESHOLDS, environmentType = DEFAULT_ENVIRONMENT_TYPE) {
  const breaches = [];
  const r = reading || {};
  const T = thresholds || THRESHOLDS;
  const env = normalizeEnvironmentType(environmentType);
  const isHome = env === "home";
  // Home reads like office for comfort wording (people, not equipment).
  const isOffice = env === "office" || isHome;
  const place = isHome ? "the home" : isOffice ? "the office" : "the work area";

  if (Number.isFinite(r.humidity) && r.humidity > T.HUMIDITY_HIGH) {
    breaches.push({
      key: "humidity",
      level: "crit",
      label: "High humidity",
      message: isHome
        ? `Humidity ${r.humidity.toFixed(0)}% (limit ${T.HUMIDITY_HIGH}%) - mold and dust-mite risk if it stays this high; run a dehumidifier or ventilate.`
        : isOffice
        ? `Humidity ${r.humidity.toFixed(0)}% (limit ${T.HUMIDITY_HIGH}%) - uncomfortable/moisture risk in ${place}.`
        : `Humidity ${r.humidity.toFixed(0)}% (limit ${T.HUMIDITY_HIGH}%) - muggy conditions for the crew and condensation risk on equipment.`,
    });
  }

  if (Number.isFinite(r.tempC) && r.tempC > T.TEMP_HIGH_C) {
    breaches.push({
      key: "temp",
      level: "crit",
      label: "High temperature",
      message: isHome
        ? `Temp ${r.tempC.toFixed(1)}C (limit ${T.TEMP_HIGH_C}C) - too hot inside; check cooling and that nobody (or any pet) is at risk.`
        : `Temp ${r.tempC.toFixed(1)}C (limit ${T.TEMP_HIGH_C}C) - heat stress risk; check cooling before extended work in ${place}.`,
    });
  }

  const base = num(baseGasR);
  if (
    Number.isFinite(r.gasR) &&
    Number.isFinite(base) &&
    base >= T.GAS_MIN_BASELINE &&
    r.gasR <= base * T.GAS_DROP_RATIO
  ) {
    const dropPct = Math.round((1 - r.gasR / base) * 100);
    breaches.push({
      key: "gas",
      level: "crit",
      label: "Air-quality spike",
      message: isOffice
        ? `Gas resistance dropped ${dropPct}% (${Math.round(r.gasR)} vs ${Math.round(base)} ohm baseline) - possible odor/contamination source in ${place}.`
        : `Gas resistance dropped ${dropPct}% (${Math.round(r.gasR)} vs ${Math.round(base)} ohm baseline) - possible smoke/fumes; crew should verify air is safe.`,
    });
  }

  if (Number.isFinite(r.iaq) && r.iaq >= T.IAQ_POOR) {
    breaches.push({
      key: "iaq",
      level: "warn",
      label: "Poor air quality",
      message: `IAQ ${r.iaq.toFixed(0)} (limit ${T.IAQ_POOR}) - degraded air quality in ${place}.`,
    });
  }

  // CO2/ventilation matters wherever people are working — office or an
  // industrial work area with a crew inside.
  if (Number.isFinite(r.co2) && r.co2 >= T.CO2_HIGH) {
    breaches.push({
      key: "co2",
      level: r.co2 >= T.CO2_HIGH * 1.4 ? "crit" : "warn",
      label: "High CO2",
      message: `CO2 ${Math.round(r.co2)} ppm (limit ${T.CO2_HIGH} ppm) - ventilation is falling behind occupancy in ${place}.`,
    });
  }

  if (isHome) breaches.push(...evaluateHomeBreaches(r, T));

  return breaches;
}

// How long a stored gas baseline is trusted before the gate forces a re-learn.
export const GAS_BASE_REFRESH_MS = 6 * 3600 * 1000;

// Margins for the /api/update ingest gate (nearAlertThreshold): how close to
// a limit counts as "near" and forces a full history-backed evaluation.
// The gas-drop test is relative to a baseline, so its margin is a ratio
// against the last computed baseline stored in alert state (trip is 0.6).
export const ALERT_GATE_MARGINS = {
  HUMIDITY: 5, // %RH below HUMIDITY_HIGH (and 5 above the 25% dry-air floor)
  TEMP_C: 2, // °C below TEMP_HIGH_C
  IAQ: 20, // IAQ points below IAQ_POOR
  CO2: 100, // ppm below CO2_HIGH
  PM25: 5, // µg/m³ below PM25_HIGH (home only)
  HCHO: 10, // ppb below the 81 ppb formaldehyde limit (home only)
  GAS_RATIO: 0.75, // gasR at/under 75% of stored baseline → full eval (trip: 60%)
};

/**
 * Cheap pre-check for the /api/update ingest path: should this snapshot get a
 * full threshold evaluation (history read + alert-state write + possible
 * notify), or is it provably a no-op?
 *
 * A full evaluation can only change something when a breach could start
 * (reading within a margin of a threshold), a breach is already active (it
 * could clear, or re-notify past cooldown), or the stored gas baseline is
 * stale/missing (the relative gas-drop test needs a fresh baseline). When
 * none of those hold, evaluateBreaches would return [] and the persisted
 * state would be unchanged, so skipping the history read is behavior-identical.
 *
 * @param {ReturnType<normalizeReading>} reading — normalized just-stored snapshot
 * @param {typeof THRESHOLDS} [thresholds] — effective limits
 * @param {"industrial"|"office"|"home"} [environmentType]
 * @param {{activeKeys?:string[], gasBase?:number, gasBaseAt?:number}} [state] — persisted alert state
 * @param {number} [nowMs] — clock, for the baseline-staleness check
 */
export function nearAlertThreshold(reading, thresholds = THRESHOLDS, environmentType = DEFAULT_ENVIRONMENT_TYPE, state = {}, nowMs = Date.now()) {
  const r = reading || {};
  const T = thresholds || THRESHOLDS;
  const env = normalizeEnvironmentType(environmentType);
  const active = new Set(Array.isArray(state?.activeKeys) ? state.activeKeys : []);
  if (active.size > 0) return true; // an active breach could clear or re-notify

  const isHome = env === "home";
  const M = ALERT_GATE_MARGINS;
  if (Number.isFinite(r.humidity) && r.humidity >= T.HUMIDITY_HIGH - M.HUMIDITY) return true;
  if (Number.isFinite(r.tempC) && r.tempC >= T.TEMP_HIGH_C - M.TEMP_C) return true;
  if (Number.isFinite(r.iaq) && r.iaq >= T.IAQ_POOR - M.IAQ) return true;
  if (Number.isFinite(r.co2) && r.co2 >= T.CO2_HIGH - M.CO2) return true;
  if (isHome) {
    if (Number.isFinite(r.pm25) && r.pm25 >= T.PM25_HIGH - M.PM25) return true;
    if (Number.isFinite(r.hcho) && r.hcho >= 81 - M.HCHO) return true;
    if (Number.isFinite(r.humidity) && r.humidity <= 25 + M.HUMIDITY) return true; // dry-air floor
  }
  // Gas-drop test: needs a baseline. No stored baseline, or one older than
  // the refresh window, means evaluate once to (re)learn it. Otherwise the
  // gate uses the stored baseline with a wider ratio than the trip ratio, so
  // baseline drift inside the window cannot hide a real breach (a miss would
  // need the true baseline to have risen >25% since the stored one).
  if (Number.isFinite(r.gasR)) {
    const base = Number(state?.gasBase);
    const baseAt = Number(state?.gasBaseAt);
    if (!Number.isFinite(base) || !Number.isFinite(baseAt) || nowMs - baseAt > GAS_BASE_REFRESH_MS) return true;
    if (base >= T.GAS_MIN_BASELINE && r.gasR <= base * M.GAS_RATIO) return true;
  }
  return false;
}
