/**
 * thresholds.js — shared reading normalization + breach evaluation.
 *
 * The device pipeline historically stored Fahrenheit (`tempF`) plus `gasR` /
 * `pressHpa`, while newer BME688 firmware may post Celsius `temperature`,
 * `gas_resistance`, and `pressure`. Everything here reads BOTH conventions and
 * normalizes to canonical units (temperature in °C) before comparing.
 *
 * Thresholds target electrical-equipment restoration in a temporary enclosure:
 *   - Humidity > 55 %RH  → condensation risk on open switchgear buswork
 *   - Temperature > 40 °C → environmental-control failure / localized overheating
 *   - Sudden gas-resistance drop OR poor IAQ → smoke / fumes / construction fumes
 *
 * NOTE: These constants are the single source of truth for the backend. The
 * static frontend cannot import this module, so it mirrors the same numbers in
 * app.js — keep them in sync if you change anything here.
 */

export const THRESHOLDS = {
  HUMIDITY_HIGH: 55, // %RH
  TEMP_HIGH_C: 40, // °C
  IAQ_POOR: 150, // BME688 IAQ index (higher = worse)
  GAS_DROP_RATIO: 0.6, // gasR at/under 60% of baseline = ≥40% sudden drop
  GAS_MIN_BASELINE: 1000, // ignore drop test below this baseline (noise floor, Ohms)
};

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

  const receivedAt = num(s.receivedAt, Date.now());

  return { tempC, humidity, pressHpa, gasR, iaq, receivedAt };
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
 * @param {ReturnType<normalizeReading>} reading
 * @param {number} [baseGasR] — baseline gas resistance for the sudden-drop test
 * @returns {Array<{key:string, level:"warn"|"crit", label:string, message:string}>}
 */
export function evaluateBreaches(reading, baseGasR) {
  const breaches = [];
  const r = reading || {};

  if (Number.isFinite(r.humidity) && r.humidity > THRESHOLDS.HUMIDITY_HIGH) {
    breaches.push({
      key: "humidity",
      level: "crit",
      label: "High humidity",
      message: `Humidity ${r.humidity.toFixed(0)}% (>${THRESHOLDS.HUMIDITY_HIGH}%) — condensation risk on switchgear buswork.`,
    });
  }

  if (Number.isFinite(r.tempC) && r.tempC > THRESHOLDS.TEMP_HIGH_C) {
    breaches.push({
      key: "temp",
      level: "crit",
      label: "High temperature",
      message: `Temp ${r.tempC.toFixed(1)}°C (>${THRESHOLDS.TEMP_HIGH_C}°C) — check environmental controls / overheating.`,
    });
  }

  const base = num(baseGasR);
  if (
    Number.isFinite(r.gasR) &&
    Number.isFinite(base) &&
    base >= THRESHOLDS.GAS_MIN_BASELINE &&
    r.gasR <= base * THRESHOLDS.GAS_DROP_RATIO
  ) {
    const dropPct = Math.round((1 - r.gasR / base) * 100);
    breaches.push({
      key: "gas",
      level: "crit",
      label: "Air-quality spike",
      message: `Gas resistance dropped ${dropPct}% (${Math.round(r.gasR)}Ω vs ${Math.round(base)}Ω baseline) — possible smoke/fumes/contamination.`,
    });
  }

  if (Number.isFinite(r.iaq) && r.iaq >= THRESHOLDS.IAQ_POOR) {
    breaches.push({
      key: "iaq",
      level: "warn",
      label: "Poor air quality",
      message: `IAQ ${r.iaq.toFixed(0)} (>=${THRESHOLDS.IAQ_POOR}) — degraded air quality in the enclosure.`,
    });
  }

  return breaches;
}
