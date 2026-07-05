/**
 * thresholds.js — shared reading normalization + breach evaluation.
 *
 * The device pipeline historically stored Fahrenheit (`tempF`) plus `gasR` /
 * `pressHpa`, while newer BME688 firmware may post Celsius `temperature`,
 * `gas_resistance`, and `pressure`. Everything here reads BOTH conventions and
 * normalizes to canonical units (temperature in °C) before comparing.
 *
 * Thresholds target electrical-equipment restoration in a temporary enclosure:
 *   - Humidity > 60 %RH  → condensation risk on open switchgear buswork
 *   - Temperature > 40 °C → environmental-control failure / localized overheating
 *   - Sudden gas-resistance drop OR poor IAQ → smoke / fumes / construction fumes
 *
 * The humidity/temperature limits are OWNER-ADJUSTABLE at runtime: the settings
 * endpoint stores overrides in Redis, and callers merge them via
 * getEffectiveThresholds() before evaluating. THRESHOLDS below are the built-in
 * defaults / fallback.
 *
 * NOTE: These constants are the single source of truth for the backend. The
 * static frontend cannot import this module, so it mirrors the same numbers in
 * app.js and pulls live overrides from /api/settings — keep the defaults in
 * sync if you change anything here.
 */

export const THRESHOLDS = {
  HUMIDITY_HIGH: 60, // %RH (loosened from 55 — was firing at the ~56% baseline)
  TEMP_HIGH_C: 40, // °C
  IAQ_POOR: 150, // BME688 IAQ index (higher = worse)
  GAS_DROP_RATIO: 0.6, // gasR at/under 60% of baseline = ≥40% sudden drop
  GAS_MIN_BASELINE: 1000, // ignore drop test below this baseline (noise floor, Ohms)
  CO2_HIGH: 1000, // ppm — ASHRAE-style indoor-air-quality guidance for occupied office space
};

// Environment presets tailor which readings matter and how they're framed.
// "construction" (default) watches a temporary enclosure drying out
// electrical equipment; "office" watches a normally-occupied workspace where
// CO2/ventilation for people matters more than switchgear condensation.
export const ENVIRONMENT_TYPES = ["construction", "office"];
export const DEFAULT_ENVIRONMENT_TYPE = "construction";

export function normalizeEnvironmentType(value) {
  const v = String(value || "").trim().toLowerCase();
  return ENVIRONMENT_TYPES.includes(v) ? v : DEFAULT_ENVIRONMENT_TYPE;
}

// Guardrails for owner-supplied overrides — a fat-fingered value must never
// disable safety monitoring (e.g. humidity set to 500 would never alarm).
export const THRESHOLD_LIMITS = {
  HUMIDITY_HIGH: { min: 40, max: 90 },
  TEMP_HIGH_C: { min: 25, max: 70 },
};

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
  return t;
}

/** Resolve the effective environment type ("construction"/"office") from stored settings. */
export function getEffectiveEnvironmentType(overrides) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  return normalizeEnvironmentType(o.environmentType);
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
  const co2 = num(s.co2);

  const receivedAt = num(s.receivedAt, Date.now());

  return { tempC, humidity, pressHpa, gasR, iaq, co2, receivedAt };
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
 * @param {"construction"|"office"} [environmentType] — tailors wording and
 *        which extra checks apply (office adds a CO2/ventilation check).
 * @returns {Array<{key:string, level:"warn"|"crit", label:string, message:string}>}
 */
export function evaluateBreaches(reading, baseGasR, thresholds = THRESHOLDS, environmentType = DEFAULT_ENVIRONMENT_TYPE) {
  const breaches = [];
  const r = reading || {};
  const T = thresholds || THRESHOLDS;
  const env = normalizeEnvironmentType(environmentType);
  const isOffice = env === "office";
  const place = isOffice ? "the office" : "the enclosure";

  if (Number.isFinite(r.humidity) && r.humidity > T.HUMIDITY_HIGH) {
    breaches.push({
      key: "humidity",
      level: "crit",
      label: "High humidity",
      message: isOffice
        ? `Humidity ${r.humidity.toFixed(0)}% (limit ${T.HUMIDITY_HIGH}%) - uncomfortable/moisture risk in ${place}.`
        : `Humidity ${r.humidity.toFixed(0)}% (limit ${T.HUMIDITY_HIGH}%) - condensation risk on switchgear buswork.`,
    });
  }

  if (Number.isFinite(r.tempC) && r.tempC > T.TEMP_HIGH_C) {
    breaches.push({
      key: "temp",
      level: "crit",
      label: "High temperature",
      message: `Temp ${r.tempC.toFixed(1)}C (limit ${T.TEMP_HIGH_C}C) - check environmental controls / overheating.`,
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
        : `Gas resistance dropped ${dropPct}% (${Math.round(r.gasR)} vs ${Math.round(base)} ohm baseline) - possible smoke/fumes/contamination.`,
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

  // CO2/ventilation only matters for occupied office space, not an unoccupied
  // construction enclosure — skip it there to avoid noise on an irrelevant metric.
  if (isOffice && Number.isFinite(r.co2) && r.co2 >= T.CO2_HIGH) {
    breaches.push({
      key: "co2",
      level: r.co2 >= T.CO2_HIGH * 1.4 ? "crit" : "warn",
      label: "High CO2",
      message: `CO2 ${Math.round(r.co2)} ppm (limit ${T.CO2_HIGH} ppm) - ventilation is falling behind occupancy.`,
    });
  }

  return breaches;
}
