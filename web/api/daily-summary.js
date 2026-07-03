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

import crypto from "node:crypto";
import {
  getHistory,
  getDailySummary,
  putDailySummary,
  getDailySummaryHistory,
  acquireDailySummaryLock,
} from "../lib/store.js";
import { normalizeReading, THRESHOLDS } from "../lib/thresholds.js";
import { sendSms } from "../lib/notify.js";
import { getCapeLaunches } from "./launches.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Idempotency guard: don't re-send if a summary was generated this recently.
const RESEND_GUARD_MS = 6 * 60 * 60 * 1000;

function timingSafeMatch(supplied, expected) {
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Cron/manual-trigger auth.
 * When CRON_SECRET is set (recommended), Vercel automatically sends
 * `Authorization: Bearer $CRON_SECRET` on cron invocations, and the same
 * header works for manual curl triggers — so the secret is the sole check.
 * Without a secret we fall back to Vercel's cron markers; those are spoofable,
 * which at worst triggers a generate+send, and the NX lock plus resend guard
 * cap that at one text per 6h window.
 */
function isAuthorized(req) {
  const secret = (process.env.CRON_SECRET || "").trim();
  const rawAuth = req.headers?.authorization || "";
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || "";
  if (secret) return timingSafeMatch(bearer, secret);
  const ua = String(req.headers?.["user-agent"] || "");
  return Boolean(req.headers?.["x-vercel-cron"]) || ua.startsWith("vercel-cron/");
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

// ASCII ohm labels: this string ships over SMS, where non-GSM-7 characters
// (like the ohm symbol) force UCS-2 encoding and shrink segments 160 -> 70.
function gasLabel(ohms) {
  if (!Number.isFinite(ohms)) return "-";
  if (ohms >= 1e6) return `${(ohms / 1e6).toFixed(2)} MOhm`;
  if (ohms >= 1e3) return `${(ohms / 1e3).toFixed(0)} kOhm`;
  return `${Math.round(ohms)} ohm`;
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

  // Note text is shared by the SMS and the dashboard panel — keep it ASCII
  // (GSM-7-safe) so the text message stays cheap and carrier-proof.
  let controlsNote;
  if (controlsStabilizing) {
    const trend =
      Number.isFinite(humidityDelta) && humidityDelta < -0.5
        ? ` (humidity down ${Math.abs(humidityDelta).toFixed(0)}% over the window)`
        : "";
    controlsNote = `AC + dehumidifiers stabilizing the space${trend}.`;
  } else {
    const reasons = [];
    if (!humidityInBand) reasons.push(`humidity avg ${fmt(humidity.avg)}% above the ${THRESHOLDS.HUMIDITY_HIGH}% limit`);
    if (!tempInBand) reasons.push(`temp avg ${fmt(temp.avg, 1)}C above the ${THRESHOLDS.TEMP_HIGH_C}C limit`);
    if (humidityInBand && tempInBand && !humidityFalling)
      reasons.push(`humidity rising (+${fmt(humidityDelta, 1)}%)`);
    controlsNote = `Environmental controls not keeping up: ${reasons.join("; ")}.`;
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
    return `SniffMaster AM report (${dateLabel})\nNo telemetry received in the last 24h - check the device power/Wi-Fi.`;
  }

  // ASCII only (GSM-7): no degree signs, ohm symbols, dashes, or emoji.
  // Metrics the device never reported are skipped rather than shown as "-".
  const lines = [`SniffMaster AM report (${dateLabel})`];
  if (s.temp) lines.push(`Temp: avg ${fmt(s.temp.avg, 1)}C (${fmt(s.temp.min, 1)} to ${fmt(s.temp.max, 1)})`);
  if (s.humidity) lines.push(`Humidity: avg ${fmt(s.humidity.avg)}% (${fmt(s.humidity.min)} to ${fmt(s.humidity.max)})`);
  if (s.pressure) lines.push(`Pressure: avg ${fmt(s.pressure.avg)} hPa`);
  const air = [];
  if (s.gas) air.push(`gas ${gasLabel(s.gas.avg)}`);
  if (s.iaq) air.push(`IAQ ${fmt(s.iaq.avg)}`);
  if (air.length) lines.push(`Air: ${air.join(", ")}`);
  lines.push(`${s.controlsStabilizing ? "OK:" : "PROBLEM:"} ${s.controlsNote}`);
  return lines.join("\n");
}

// ── Personal daily report ───────────────────────────────────────────────
// The morning text reads like a friendly personal report: how the enclosure
// held up overnight, whether the AC + dehumidifiers are doing their job, the
// hard numbers, and any Cape Canaveral launches scheduled today. OpenAI writes
// the narrative when OPENAI_API_KEY is set (same key as the weather briefing);
// otherwise a deterministic template is used. The text never mentions AI/GPT
// or that it is generated, and stays GSM-7-safe ASCII throughout.

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const REPORT_MAX_CHARS = 320;

function sanitizeSmsAscii(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\n]/g, "")
    // Belt-and-suspenders: the report must never present itself as AI-written.
    .replace(/\b(BroGPT|ChatGPT|GPT[-\w]*|AI|A\.I\.|AI-generated|language model|chatbot)\b/gi, "")
    .replace(/\bas an\s+(from\s+)?[,.]?\s*/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function statsLine(s) {
  const bits = [];
  if (s.temp) bits.push(`${fmt(s.temp.avg, 1)}C`);
  if (s.humidity) bits.push(`${fmt(s.humidity.avg)}%RH`);
  if (s.pressure) bits.push(`${fmt(s.pressure.avg)}hPa`);
  if (s.gas) bits.push(`gas ${gasLabel(s.gas.avg)}`);
  if (s.iaq) bits.push(`IAQ ${fmt(s.iaq.avg)}`);
  return bits.length ? `24h avg: ${bits.join(", ")}` : "";
}

function reportFallbackText(s) {
  if (s.controlsStabilizing) {
    const trend =
      Number.isFinite(s.humidityDelta) && s.humidityDelta < -0.5
        ? ` Humidity eased down ${Math.abs(s.humidityDelta).toFixed(0)}% overnight - the dehumidifiers are doing their job.`
        : " The AC and dehumidifiers are holding steady.";
    return `Good morning! Overnight report from the enclosure: everything stayed in the safe zone.${trend} The switchgear is staying dry.`;
  }
  return `Morning - heads up on the enclosure. ${s.controlsNote} Worth checking the AC and dehumidifiers today before condensation becomes a problem.`;
}

/** ET calendar date (YYYY-MM-DD) for a timestamp, for "today" comparisons. */
function etDateKey(ts) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function etClock(ts) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

/**
 * "Launches today" line for the morning text.
 * Returns "" when the schedule can't be fetched (better silent than wrong).
 */
function launchesTodayLine(launches, now = Date.now()) {
  if (!Array.isArray(launches)) return "";
  const today = etDateKey(now);
  const todays = launches
    .map((l) => {
      const raw = l?.t0 || l?.winOpen;
      const ts = raw ? Date.parse(raw) : NaN;
      return Number.isFinite(ts) && etDateKey(ts) === today ? { name: l.name || "Launch", ts } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  if (!todays.length) return "No Cape launches scheduled today.";
  const shown = todays.slice(0, 2).map((l) => `${l.name} at ${etClock(l.ts)} ET`);
  const more = todays.length > 2 ? ` +${todays.length - 2} more` : "";
  return `Cape launch${todays.length > 1 ? "es" : ""} today: ${shown.join("; ")}${more}.`;
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }
  const parts = [];
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  output.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((piece) => {
      if (typeof piece?.text === "string" && piece.text.trim()) parts.push(piece.text.trim());
    });
  });
  return parts.join("\n").trim();
}

async function generateReportText(s) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = `${process.env.OPENAI_REPORT_MODEL || "gpt-5.4-nano"}`.trim();

  const prompt = [
    "Write a short, warm good-morning SMS from an environmental monitor to its owner.",
    "Context: a sensor watches a temporary enclosure protecting electrical switchgear that is drying out after an incident. AC and dehumidifiers run to keep it safe (humidity must stay under 55%, temp under 40C).",
    "Requirements: 2-3 sentences, max 300 characters, plain ASCII only (no emoji, no degree symbols).",
    "Tone: a nice personal daily report - friendly and direct, like a trusted site tech texting their boss.",
    "Never mention AI, GPT, chatbots, models, or that this message is generated - it is simply the morning report.",
    "Clearly state whether the AC and dehumidifiers kept the space safe overnight; if there is a problem, say it plainly and what to check.",
    "",
    `24h data: ${JSON.stringify({
      tempC_avg: s.temp ? Number(s.temp.avg.toFixed(1)) : null,
      humidity_avg: s.humidity ? Number(s.humidity.avg.toFixed(0)) : null,
      humidity_max: s.humidity ? Number(s.humidity.max.toFixed(0)) : null,
      humidity_trend: Number.isFinite(s.humidityDelta) ? Number(s.humidityDelta.toFixed(1)) : null,
      iaq_avg: s.iaq ? Number(s.iaq.avg.toFixed(0)) : null,
      controls_stabilizing: s.controlsStabilizing,
      verdict: s.controlsNote,
    })}`,
  ].join("\n");

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: prompt, max_output_tokens: 150 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const text = sanitizeSmsAscii(extractOutputText(await res.json()));
  return text ? text.slice(0, REPORT_MAX_CHARS) : null;
}

/**
 * Compose the morning SMS: personal report + stats line + today's Cape launches.
 * Never throws; every piece degrades independently.
 */
async function composeReportSms(s, launches) {
  if (!s.sampleCount) {
    const dark =
      "Good morning - heads up: the enclosure sensor went quiet overnight (no data in 24h). Check the device power and WiFi when you get a chance.";
    return { smsText: dark, reportText: dark, reportMode: "deterministic" };
  }

  let reportText = null;
  let reportMode = "deterministic";
  try {
    reportText = await generateReportText(s);
    if (reportText) reportMode = "openai";
  } catch (err) {
    console.error("daily-summary: report generation failed, using fallback:", err?.message || err);
  }
  if (!reportText) reportText = reportFallbackText(s);

  const launchLine = launchesTodayLine(launches);
  const smsText = sanitizeSmsAscii([reportText, statsLine(s), launchLine].filter(Boolean).join("\n"));
  return { smsText, reportText, reportMode, launchLine };
}

// Exported for unit testing; the Vercel runtime only invokes the default export.
export { buildSummary, summaryToSms, composeReportSms, reportFallbackText, sanitizeSmsAscii, launchesTodayLine };

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
    // Idempotency, two layers: a fast read check, then an atomic SET NX lock
    // so even two simultaneous triggers can't both send.
    const existing = await getDailySummary();
    if (existing && Date.now() - Number(existing.generatedAt || 0) < RESEND_GUARD_MS) {
      return res.status(200).json({ ...existing, skipped: "recently generated" });
    }
    const wonLock = await acquireDailySummaryLock(RESEND_GUARD_MS / 1000);
    if (!wonLock) {
      return res.status(200).json({ ...(existing || {}), skipped: "another run holds the lock" });
    }

    const history = await getHistory(288); // up to ~48h @ 10min, we filter to 24h
    const summary = buildSummary(history);

    // Launch schedule is decoration — never let it block the report.
    let launches = null;
    try {
      launches = await getCapeLaunches();
    } catch (err) {
      console.error("daily-summary: launches fetch failed:", err?.message || err);
    }

    const { smsText, reportText, reportMode, launchLine } = await composeReportSms(summary, launches);

    const smsResult = await sendSms(smsText);
    const stored = await putDailySummary({
      ...summary,
      smsText,
      reportText,
      reportMode,
      launchLine,
      plainText: summaryToSms(summary),
    });

    return res.status(200).json({
      ...stored,
      sms: { configured: smsResult.configured, sent: smsResult.sent, failures: smsResult.failures },
    });
  } catch (err) {
    console.error("daily-summary generate error:", err);
    return res.status(500).json({ error: "summary error" });
  }
}
