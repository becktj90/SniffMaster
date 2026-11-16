// Sensor Health page helpers.
//
// Pure functions for the #/sensor-health page: feed freshness, Wi-Fi
// quality, per-reading validity, and uptime formatting. No DOM, no network
// — the dashboard script (app.js, a classic script) uses the
// `window.SniffHealth` global below; the exports keep the logic testable
// from node.
//
// Data sources (all existing endpoints, no new API):
//   /api/latest  — the device snapshot: receivedAt, uptime, wifiRssi, iaq,
//                  co2, tempF, humidity, pressHpa, gasR, iaqAcc, ...
//   /api/health  — server storage probe (Upstash Redis reachable?)
//   /api/version — deployed dashboard version/commit

// Same 15-minute "live" rule as the header status (app.js setStatus).
export var FEED_LIVE_MS = 15 * 60 * 1000;

function isNum(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

/**
 * Feed freshness from the last reading's timestamp.
 * @param {number|string|null|undefined} receivedAt ms epoch of last reading
 * @param {number} nowMs Date.now()
 * @returns {{state: string, ageMs: number|null}} state: "live" | "stale" | "none"
 */
export function feedState(receivedAt, nowMs) {
  if (!isNum(receivedAt)) return { state: "none", ageMs: null };
  var age = Math.max(0, nowMs - Number(receivedAt));
  return { state: age < FEED_LIVE_MS ? "live" : "stale", ageMs: age };
}

/**
 * Plain-language Wi-Fi quality from the device's RSSI (dBm). Conventional
 * bands: -55 dBm and up is a strong signal, below -75 dBm the link is
 * marginal and drops are likely.
 * @param {number|string|null|undefined} rssi
 * @returns {{label: string, tone: string, dbm: number|null}}
 */
export function wifiState(rssi) {
  if (!isNum(rssi)) return { label: "Unknown", tone: "na", dbm: null };
  var dbm = Math.round(Number(rssi));
  if (dbm >= -55) return { label: "Strong", tone: "good", dbm: dbm };
  if (dbm >= -67) return { label: "Good", tone: "good", dbm: dbm };
  if (dbm >= -75) return { label: "Fair", tone: "fair", dbm: dbm };
  return { label: "Weak", tone: "poor", dbm: dbm };
}

/**
 * Per-reading presence/validity from the latest snapshot, plus the
 * "publishing" check the Sensors page uses (gas resistance flowing and
 * IAQ + CO₂ present and positive).
 * @param {object|null|undefined} L latest snapshot
 * @returns {{rows: Array<{key: string, label: string, text: string, ok: boolean}>, publishing: boolean}}
 */
export function readingChecks(L) {
  var s = L || {};
  function row(key, label, text, ok) {
    return { key: key, label: label, text: text, ok: !!ok };
  }
  var rows = [
    row("iaq", "IAQ", isNum(s.iaq) ? String(Math.round(Number(s.iaq))) : "—", isNum(s.iaq)),
    row("co2", "CO₂", isNum(s.co2) && Number(s.co2) > 0 ? Math.round(Number(s.co2)) + " ppm" : "—", isNum(s.co2) && Number(s.co2) > 0),
    row("tempF", "Temperature", isNum(s.tempF) ? Number(s.tempF).toFixed(1) + " °F" : "—", isNum(s.tempF)),
    row("humidity", "Humidity", isNum(s.humidity) ? Number(s.humidity).toFixed(1) + " %" : "—", isNum(s.humidity)),
    row("pressHpa", "Pressure", isNum(s.pressHpa) ? Number(s.pressHpa).toFixed(1) + " hPa" : "—", isNum(s.pressHpa)),
    row("gasR", "Gas resistance", isNum(s.gasR) && Number(s.gasR) > 0 ? Math.round(Number(s.gasR)).toLocaleString("en-US") + " Ω" : "—", isNum(s.gasR) && Number(s.gasR) > 0),
  ];
  var publishing = isNum(s.gasR) && Number(s.gasR) > 0 && isNum(s.iaq) && isNum(s.co2) && Number(s.co2) > 0;
  return { rows: rows, publishing: publishing };
}

/**
 * Device uptime in plain words: minutes under an hour, hours under two
 * days, days beyond that.
 * @param {number|string|null|undefined} seconds
 * @returns {string} e.g. "12 min", "5.9 h", "3.2 d", or "—"
 */
export function fmtUptime(seconds) {
  if (!isNum(seconds)) return "—";
  var s = Number(seconds);
  if (s < 0) return "—";
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min";
  if (s < 2 * 86400) return (s / 3600).toFixed(1) + " h";
  return (s / 86400).toFixed(1) + " d";
}

if (typeof window !== "undefined") {
  window.SniffHealth = {
    feedState: feedState,
    wifiState: wifiState,
    readingChecks: readingChecks,
    fmtUptime: fmtUptime,
    FEED_LIVE_MS: FEED_LIVE_MS,
  };
  window.dispatchEvent(new Event("sniff-health-ready"));
}
