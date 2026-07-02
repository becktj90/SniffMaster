/**
 * GET /api/daily-summary
 *
 * Two roles:
 *   1. Cron target — when called by Vercel Cron (header `x-vercel-cron`) or with
 *      `Authorization: Bearer $CRON_SECRET`, it computes the last-24h baseline,
 *      texts the owner the morning report, stores it, and returns the JSON.
 *   2. Dashboard read — any unauthenticated GET returns the most recently stored
 *      summary (read-only, no SMS sent) so the page can render the panel.
 *
 * Scheduled via vercel.json crons at 10:00 UTC (06:00 US Eastern during EDT).
 */

import { getHistory, getDailySummary, putDailySummary, getDailySummaryHistory } from "../lib/store.js";
import { normalizeReading, THRESHOLDS } from "../lib/thresholds.js";
import { sendSms } from "../lib/notify.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Idempotency guard: don't re-send if a summary was generated this recently.
const RESEND_GUARD_MS = 6 * 60 * 60 * 1000;

function isAuthorized(req) {
  if (req.headers?.["x-vercel-cron"]) return true;
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const auth = req.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  return Boolean(match && match[1].trim() === secret);
}

function stats(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return null;
  const sum = finite.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...finite),
    max: Math.max(...finite),
    avg: sum / finite.length,
    count: finite.length,
  };
}

/** Compare newer half vs older half mean; negative delta = falling. */
function halfDelta(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 4) return null;
  const mid = Math.floor(finite.length / 2);
  // history is newest-first, so index 0..mid = newer, mid..end = older
  const newer = finite.slice(0, mid);
  const older = finite.slice(mid);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return mean(newer) - mean(older);
}

function fmt(n, digits = 0) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function gasLabel(ohms) {
  if (!Number.isFinite(ohms)) return "—";
  if (ohms >= 1e6) return `${(ohms / 1e6).toFixed(2)}MΩ`;
  if (ohms >= 1e3) return `${(ohms / 1e3).toFixed(0)}kΩ`;
  return `${Math.round(ohms)}Ω`;
}

function buildSummary(history) {
  const now = Date.now();
  const window = history.filter((h) => {
    const r = normalizeReading(h);
    return Number.isFinite(r.receivedAt) && now - r.receivedAt <= DAY_MS;
  });
  const readings = window.map(normalizeReading);

  const temp = stats(readings.map((r) => r.tempC));
  const humidity = stats(readings.map((r) => r.humidity));
  const pressure = stats(readings.map((r) => r.pressHpa));
  const gas = stats(readings.map((r) => r.gasR));
  const iaq = stats(readings.map((r) => r.iaq));

  const humidityDelta = halfDelta(readings.map((r) => r.humidity));
  const tempDelta = halfDelta(readings.map((r) => r.tempC));

  // "Controls stabilizing?" — humidity and temperature within safe band and
  // not trending upward means the AC + dehumidifiers are holding the space.
  const humidityInBand = !humidity || humidity.avg <= THRESHOLDS.HUMIDITY_HIGH;
  const tempInBand = !temp || temp.avg <= THRESHOLDS.TEMP_HIGH_C;
  const humidityFalling = humidityDelta === null || humidityDelta <= 1; // ≤ +1% drift
  const controlsStabilizing = Boolean(humidityInBand && tempInBand && humidityFalling);

  let controlsNote;
  if (controlsStabilizing) {
    const trend =
      Number.isFinite(humidityDelta) && humidityDelta < -0.5
        ? ` (humidity ↓${Math.abs(humidityDelta).toFixed(0)}% over the window)`
        : "";
    controlsNote = `AC + dehumidifiers stabilizing the space${trend}.`;
  } else {
    const reasons = [];
    if (!humidityInBand) reasons.push(`humidity avg ${fmt(humidity.avg)}% > ${THRESHOLDS.HUMIDITY_HIGH}%`);
    if (!tempInBand) reasons.push(`temp avg ${fmt(temp.avg, 1)}°C > ${THRESHOLDS.TEMP_HIGH_C}°C`);
    if (humidityInBand && tempInBand && !humidityFalling)
      reasons.push(`humidity rising (+${fmt(humidityDelta, 1)}%)`);
    controlsNote = `Environmental controls not keeping up — ${reasons.join("; ")}.`;
  }

  return {
    windowHours: 24,
    sampleCount: readings.length,
    temp,
    humidity,
    pressure,
    gas,
    iaq,
    humidityDelta,
    tempDelta,
    controlsStabilizing,
    controlsNote,
    generatedAt: now,
  };
}

function summaryToSms(s) {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(s.generatedAt));

  if (!s.sampleCount) {
    return `SniffMaster AM report (${dateLabel})\nNo telemetry received in the last 24h — check the device power/Wi-Fi.`;
  }

  const lines = [
    `SniffMaster AM report (${dateLabel})`,
    `Temp: avg ${fmt(s.temp?.avg, 1)}°C (${fmt(s.temp?.min, 1)}–${fmt(s.temp?.max, 1)})`,
    `Humidity: avg ${fmt(s.humidity?.avg)}% (${fmt(s.humidity?.min)}–${fmt(s.humidity?.max)})`,
    `Pressure: avg ${fmt(s.pressure?.avg)} hPa`,
    `Air: gasR ${gasLabel(s.gas?.avg)}, IAQ ${fmt(s.iaq?.avg)}`,
    `${s.controlsStabilizing ? "✅" : "❌"} ${s.controlsNote}`,
  ];
  return lines.join("\n");
}

// Exported for unit testing; the Vercel runtime only invokes the default export.
export { buildSummary, summaryToSms };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // Unauthenticated read: serve the last stored summary for the dashboard panel.
  if (!isAuthorized(req)) {
    try {
      const [latest, history] = await Promise.all([
        getDailySummary(),
        getDailySummaryHistory(14),
      ]);
      if (!latest) return res.status(204).end();
      return res.status(200).json({ ...latest, recent: history });
    } catch (err) {
      console.error("daily-summary read error:", err);
      return res.status(500).json({ error: "storage error" });
    }
  }

  // Authorized (cron / secret): compute, text, store.
  try {
    // Idempotency guard against a double cron fire within the same window.
    const existing = await getDailySummary();
    if (existing && Date.now() - Number(existing.generatedAt || 0) < RESEND_GUARD_MS) {
      return res.status(200).json({ ...existing, skipped: "recently generated" });
    }

    const history = await getHistory(288); // up to ~48h @ 10min, we filter to 24h
    const summary = buildSummary(history);
    const smsText = summaryToSms(summary);

    const smsResult = await sendSms(smsText);
    const stored = await putDailySummary({ ...summary, smsText });

    return res.status(200).json({
      ...stored,
      sms: { configured: smsResult.configured, sent: smsResult.sent, failures: smsResult.failures },
    });
  } catch (err) {
    console.error("daily-summary generate error:", err);
    return res.status(500).json({ error: "summary error" });
  }
}
