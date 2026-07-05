/**
 * GET /api/daily-summary
 *
 * Two roles:
 *   1. Cron target — when called by Vercel Cron (header `x-vercel-cron`) or with
 *      `Authorization: Bearer $CRON_SECRET`, it computes the last-24h baseline,
 *      texts the owner the morning report, stores it, and returns the JSON.
 *      Add `?force=true` (authorized only) to bypass the 6h resend guard and
 *      lock — for previewing the report format on demand; it WILL send again.
 *   2. Dashboard read — any unauthenticated GET returns the most recently stored
 *      summary (read-only, no SMS sent) so the page can render the panel.
 *
 * Scheduled via vercel.json crons at 10:00 UTC (06:00 US Eastern during EDT),
 * with a second slot at 10:40 UTC that acts purely as a delivery-retry sweep:
 * if the first run generated the report but every send failed, the second run
 * re-sends the stored text; if the first run delivered, it no-ops.
 */

import crypto from "node:crypto";
import {
  getHistory,
  getDailySummary,
  putDailySummary,
  getDailySummaryHistory,
  acquireDailySummaryLock,
  acquireManualReportLock,
  markDailySummaryDelivered,
  getSettings,
} from "../lib/store.js";
import {
  normalizeReading,
  THRESHOLDS,
  getEffectiveThresholds,
  getEffectiveEnvironmentType,
} from "../lib/thresholds.js";
import { sendSms, isSmsConfigured, PUBLIC_BASE_URL } from "../lib/notify.js";
// Shared SMS-text helpers (single source of truth; also used by the alert path).
import { sanitizeSmsAscii, extractOutputText } from "../lib/brogpt.js";
import { getCapeLaunches } from "../lib/launches.js";
import { fetchLc36Outlook } from "../lib/forecast.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Idempotency guard: don't re-send if a summary was generated this recently.
const RESEND_GUARD_MS = 6 * 60 * 60 * 1000;
// How often an unauthenticated "send me a test report now" request may fire —
// see ?manual=true below. Real money (ClickSend) is spent per send, so this
// stays tight even though the dashboard itself has no login.
const MANUAL_TEST_COOLDOWN_SEC = 300;

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

// ASCII-only placeholder: an em-dash here would need sanitizeSmsAscii to run
// downstream to become "-", and not every caller of fmt() (the real-time
// alert's stats block, in particular) does that — ship ASCII directly so a
// missed sanitize pass degrades to a readable "n/a" instead of a silently
// stripped blank.
function fmt(n, digits = 0) {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

// Report text speaks Fahrenheit; internals (stats, thresholds, stored
// summaries) stay Celsius so history and the dashboard remain comparable.
const cToF = (c) => (c * 9) / 5 + 32;

/** "+1.8%" / "-0.3%" — relative change of a current value vs its baseline. */
function pctDiff(current, baselineValue) {
  if (!Number.isFinite(current) || !Number.isFinite(baselineValue) || baselineValue === 0) return null;
  const pct = ((current - baselineValue) / Math.abs(baselineValue)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/**
 * Collapse stored summaries to one per ET calendar day (multiple cron runs on
 * the same day keep only the newest), excluding today, newest-day-first.
 * Shared by buildBaseline (the % vs norm math) and computeProblemStreak (the
 * "Nth day in a row" math) so both agree on what "a day" means.
 */
function dedupeSummariesByDay(prevSummaries, now = Date.now()) {
  const today = etDateKey(now);
  const byDay = new Map();
  (Array.isArray(prevSummaries) ? prevSummaries : []).forEach((s) => {
    const ts = Number(s?.generatedAt);
    if (!Number.isFinite(ts)) return;
    const day = etDateKey(ts);
    if (day === today || byDay.has(day)) return; // newest-first: keep latest per day
    byDay.set(day, s);
  });
  return [...byDay.values()];
}

/**
 * Per-metric norm from previously stored summaries: the mean of each metric's
 * daily average over the retained history. Multiple runs on the same ET day
 * collapse to the newest, and today's runs are excluded, so the comparison is
 * genuinely "today vs prior days". days === 0 means no usable baseline yet.
 */
function buildBaseline(prevSummaries, now = Date.now()) {
  const days = dedupeSummariesByDay(prevSummaries, now);
  const mean = (pick) => {
    const vals = days.map(pick).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const tempCAvg = mean((d) => d?.temp?.avg);
  return {
    days: days.length,
    tempF: Number.isFinite(tempCAvg) ? cToF(tempCAvg) : null,
    humidity: mean((d) => d?.humidity?.avg),
    pressure: mean((d) => d?.pressure?.avg),
    gas: mean((d) => d?.gas?.avg),
    iaq: mean((d) => d?.iaq?.avg),
    co2: mean((d) => d?.co2?.avg),
  };
}

/**
 * How many consecutive days (walking back from today) controlsStabilizing has
 * been false, so wording can say "3rd day in a row" instead of reading
 * identically whether a problem started today or five days ago.
 * @returns {{streakDays:number, justRecovered:boolean}} streakDays is 0 when
 *   today is fine; justRecovered is true when today is fine but yesterday
 *   (the most recent prior day) wasn't.
 */
function computeProblemStreak(prevSummaries, todayStabilizing, now = Date.now()) {
  const days = dedupeSummariesByDay(prevSummaries, now); // newest-first
  if (todayStabilizing) {
    return { streakDays: 0, justRecovered: days[0]?.controlsStabilizing === false };
  }
  let streakDays = 1; // today counts as day 1 of the streak
  for (const day of days) {
    if (day?.controlsStabilizing === false) streakDays += 1;
    else break;
  }
  return { streakDays, justRecovered: false };
}

/**
 * Server-side change-vs-norm per metric (numeric %, 1 decimal), so the
 * dashboard renders deltas straight from the stored summary without
 * recomputing baselines client-side. null = no comparable baseline.
 */
function buildDeltas(s, baseline) {
  const pct = (cur, base) => {
    if (!Number.isFinite(cur) || !Number.isFinite(base) || base === 0) return null;
    return Number((((cur - base) / Math.abs(base)) * 100).toFixed(1));
  };
  return {
    baselineDays: baseline?.days || 0,
    tempF: pct(s.temp ? cToF(s.temp.avg) : NaN, baseline?.tempF),
    humidity: pct(s.humidity?.avg, baseline?.humidity),
    pressure: pct(s.pressure?.avg, baseline?.pressure),
    gas: pct(s.gas?.avg, baseline?.gas),
    iaq: pct(s.iaq?.avg, baseline?.iaq),
    co2: pct(s.co2?.avg, baseline?.co2),
  };
}

// ASCII ohm labels: this string ships over SMS, where non-GSM-7 characters
// (like the ohm symbol) force UCS-2 encoding and shrink segments 160 -> 70.
function gasLabel(ohms) {
  if (!Number.isFinite(ohms)) return "-";
  if (ohms >= 1e6) return `${(ohms / 1e6).toFixed(2)} MOhm`;
  if (ohms >= 1e3) return `${(ohms / 1e3).toFixed(0)} kOhm`;
  return `${Math.round(ohms)} ohm`;
}

function buildSummary(history, thresholds = THRESHOLDS, environmentType = "industrial") {
  const T = thresholds || THRESHOLDS;
  const isOffice = environmentType === "office";
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
  // CO2 matters wherever people work — tracked in both environment modes.
  const co2 = stats(readings.map((r) => r.co2));

  const humidityDelta = halfDelta(readings.map((r) => r.humidity));
  const tempDelta = halfDelta(readings.map((r) => r.tempC));

  // "Controls stabilizing?" — humidity, temperature, and CO2 within safe band
  // and humidity not trending upward means the environmental controls are
  // keeping the space workable for the people in it.
  // Uses the same owner-adjustable limits as the real-time alerts.
  const humidityInBand = !humidity || humidity.avg <= T.HUMIDITY_HIGH;
  const tempInBand = !temp || temp.avg <= T.TEMP_HIGH_C;
  const co2InBand = !co2 || co2.avg <= T.CO2_HIGH;
  const humidityFalling = humidityDelta === null || humidityDelta <= 1; // ≤ +1% drift
  const controlsStabilizing = Boolean(humidityInBand && tempInBand && co2InBand && humidityFalling);

  // Note text is shared by the SMS and the dashboard panel — keep it ASCII
  // (GSM-7-safe) so the text message stays cheap and carrier-proof.
  let controlsNote;
  if (controlsStabilizing) {
    const trend =
      Number.isFinite(humidityDelta) && humidityDelta < -0.5
        ? ` (humidity down ${Math.abs(humidityDelta).toFixed(0)}% over the window)`
        : "";
    controlsNote = isOffice
      ? `HVAC holding comfortable conditions${trend}.`
      : `Cooling + dehumidifiers holding workable conditions${trend}.`;
  } else {
    const reasons = [];
    if (!humidityInBand) reasons.push(`humidity avg ${fmt(humidity.avg)}% above the ${T.HUMIDITY_HIGH}% limit`);
    if (!tempInBand) reasons.push(`temp avg ${fmt(cToF(temp.avg), 1)}F above the ${fmt(cToF(T.TEMP_HIGH_C))}F limit`);
    if (!co2InBand) reasons.push(`CO2 avg ${fmt(co2.avg)} ppm above the ${T.CO2_HIGH} ppm limit`);
    if (humidityInBand && tempInBand && co2InBand && !humidityFalling)
      reasons.push(`humidity rising (+${fmt(humidityDelta, 1)}%)`);
    controlsNote = isOffice
      ? `HVAC not keeping up: ${reasons.join("; ")}.`
      : `Environmental controls not keeping up: ${reasons.join("; ")}.`;
  }

  return {
    windowHours: 24,
    sampleCount: readings.length,
    temp,
    humidity,
    pressure,
    gas,
    iaq,
    co2,
    environmentType: isOffice ? "office" : "industrial",
    humidityDelta,
    tempDelta,
    controlsStabilizing,
    controlsNote,
    generatedAt: now,
  };
}

function summaryToSms(s, baseline = null, headerLabel = "AM report") {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(s.generatedAt));

  if (!s.sampleCount) {
    return `SniffMaster ${headerLabel} (${dateLabel})\nNo telemetry received in the last 24h - check the device power/Wi-Fi.`;
  }

  // ASCII only (GSM-7): no degree signs, ohm symbols, dashes, or emoji.
  // Metrics the device never reported are skipped rather than shown as "-".
  const tag = (cur, base) => {
    const d = pctDiff(cur, base);
    return d ? `, ${d}` : "";
  };
  const lines = [`SniffMaster ${headerLabel} (${dateLabel})`];
  if (s.temp)
    lines.push(
      `Temp: ${fmt(cToF(s.temp.avg), 1)}F (${fmt(cToF(s.temp.min), 1)} to ${fmt(cToF(s.temp.max), 1)})${tag(cToF(s.temp.avg), baseline?.tempF)}`
    );
  if (s.humidity)
    lines.push(`Humidity: ${fmt(s.humidity.avg)}% (${fmt(s.humidity.min)} to ${fmt(s.humidity.max)})${tag(s.humidity.avg, baseline?.humidity)}`);
  if (s.pressure) lines.push(`Pressure: ${fmt(s.pressure.avg)} hPa${tag(s.pressure.avg, baseline?.pressure)}`);
  const air = [];
  if (s.gas) air.push(`gas ${gasLabel(s.gas.avg)}${tag(s.gas.avg, baseline?.gas)}`);
  if (s.iaq) air.push(`IAQ ${fmt(s.iaq.avg)}${tag(s.iaq.avg, baseline?.iaq)}`);
  if (s.co2) air.push(`CO2 ${fmt(s.co2.avg)} ppm${tag(s.co2.avg, baseline?.co2)}`);
  if (air.length) lines.push(`Air: ${air.join("; ")}`);
  if (baseline?.days) lines.push(`(% = change vs ${baseline.days}-day avg)`);
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

/**
 * @param {ReturnType<typeof buildSummary>} s
 * @param {{streakDays:number, justRecovered:boolean}} [streak] — from
 *   computeProblemStreak(); makes the same breach type read differently on
 *   day 1 vs day 5 of the same problem, or when it just cleared, instead of
 *   a canned line that reads identically regardless of history.
 */
function reportFallbackText(s, streak = { streakDays: 0, justRecovered: false }) {
  const isOffice = s.environmentType === "office";
  if (s.controlsStabilizing) {
    const trend =
      Number.isFinite(s.humidityDelta) && s.humidityDelta < -0.5
        ? ` Humidity eased down ${Math.abs(s.humidityDelta).toFixed(0)}% overnight - conditions are comfortable.`
        : " The HVAC is holding steady.";
    if (streak.justRecovered) {
      return isOffice
        ? "Good morning! The office is back to comfortable this morning after yesterday's trouble - worth a quick check that whatever caused it hasn't just paused."
        : "Good morning! The work area is back in the safe zone this morning after yesterday's trouble - worth a quick check that whatever caused it hasn't just paused.";
    }
    if (isOffice) {
      return `Good morning! Overnight report from the office: everything stayed comfortable.${trend}`;
    }
    const crewTrend =
      Number.isFinite(s.humidityDelta) && s.humidityDelta < -0.5
        ? ` Humidity eased down ${Math.abs(s.humidityDelta).toFixed(0)}% overnight.`
        : " Cooling and dehumidifiers are holding steady.";
    return `Good morning! Overnight report from the work area: conditions stayed in the safe zone for the crew.${crewTrend}`;
  }
  const streakNote =
    streak.streakDays >= 3
      ? ` This is day ${streak.streakDays} in a row - worth more than a quick fix at this point.`
      : streak.streakDays === 2
        ? " Second day in a row now."
        : "";
  if (isOffice) {
    return `Morning - heads up on the office. ${s.controlsNote}${streakNote} Worth checking the HVAC today.`;
  }
  return `Morning - heads up on the work area. ${s.controlsNote}${streakNote} Worth checking the cooling and ventilation before the crew settles in.`;
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

async function generateReportText(s, baseline = null, streak = { streakDays: 0, justRecovered: false }) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = `${process.env.OPENAI_REPORT_MODEL || "gpt-5.4-nano"}`.trim();
  const isOffice = s.environmentType === "office";

  const contextLine = isOffice
    ? "Context: a sensor watches an office space, tracking air quality and comfort for the people working there. HVAC keeps CO2, humidity, and temp in a comfortable range."
    : "Context: a sensor watches an industrial work area where a crew works around equipment. What matters is whether conditions are safe and workable for the people: heat stress, humidity, air quality, and ventilation (CO2).";
  const verdictLine = isOffice
    ? "Clearly state whether the office stayed comfortable overnight (HVAC and air quality); if there is a problem, say it plainly and what to check."
    : "Clearly state whether conditions stayed safe and workable for the crew overnight; if there is a problem, say it plainly and what to check.";

  const prompt = [
    "Write a short, warm good-morning SMS from an environmental monitor to its owner.",
    contextLine,
    "Requirements: 2-3 sentences, max 300 characters, plain ASCII only (no emoji, no degree symbols). Use Fahrenheit for any temperature you mention.",
    "Tone: a nice personal daily report - friendly and direct, like a trusted site tech texting their boss.",
    "Never mention AI, GPT, chatbots, models, or that this message is generated - it is simply the morning report.",
    verdictLine,
    "Make this report distinct from a generic template: reference the specific numbers below, how they compare to the recent-days average (pct fields), and the day streak/recovery info if present - don't just restate the verdict in different words every day.",
    "",
    `24h data: ${JSON.stringify({
      tempF_avg: s.temp ? Number(cToF(s.temp.avg).toFixed(1)) : null,
      tempF_vs_norm_pct: Number.isFinite(baseline?.tempF) ? pctDiff(cToF(s.temp?.avg), baseline.tempF) : null,
      humidity_avg: s.humidity ? Number(s.humidity.avg.toFixed(0)) : null,
      humidity_max: s.humidity ? Number(s.humidity.max.toFixed(0)) : null,
      humidity_trend: Number.isFinite(s.humidityDelta) ? Number(s.humidityDelta.toFixed(1)) : null,
      humidity_vs_norm_pct: Number.isFinite(baseline?.humidity) ? pctDiff(s.humidity?.avg, baseline.humidity) : null,
      iaq_avg: s.iaq ? Number(s.iaq.avg.toFixed(0)) : null,
      co2_avg: s.co2 ? Number(s.co2.avg.toFixed(0)) : null,
      co2_vs_norm_pct: Number.isFinite(baseline?.co2) ? pctDiff(s.co2?.avg, baseline.co2) : null,
      controls_stabilizing: s.controlsStabilizing,
      verdict: s.controlsNote,
      problem_streak_days: streak.streakDays,
      just_recovered_today: streak.justRecovered,
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
 * Compose the morning SMS: a short personal-voice summary + today's Cape
 * launches (one line) + a link to the full visual report (/report) — the
 * detailed stats/weather breakdown lives there instead of as a raw text
 * dump, so the text itself stays a "simple summary" rather than a report.
 * Never throws; every piece degrades independently.
 * @param {Array} [prevSummaries] — from getDailySummaryHistory(); powers the
 *   day-streak/recovery wording so the same breach reads differently on day
 *   1 vs day 5, instead of an identical canned line either way.
 */
async function composeReportSms(s, launches, baseline = null, outlook = null, prevSummaries = []) {
  const reportUrl = `${PUBLIC_BASE_URL}/report`;
  if (!s.sampleCount) {
    const dark =
      "Good morning - heads up: the site sensor went quiet overnight (no data in 24h). Check the device power and WiFi when you get a chance.";
    return { smsText: dark, reportText: dark, reportMode: "deterministic" };
  }

  const streak = computeProblemStreak(prevSummaries, s.controlsStabilizing);

  let reportText = null;
  let reportMode = "deterministic";
  try {
    reportText = await generateReportText(s, baseline, streak);
    if (reportText) reportMode = "openai";
  } catch (err) {
    console.error("daily-summary: report generation failed, using fallback:", err?.message || err);
  }
  if (!reportText) reportText = reportFallbackText(s, streak);

  const launchLine = launchesTodayLine(launches);
  const smsText = sanitizeSmsAscii(
    [reportText, launchLine, `Full report: ${reportUrl}`].filter(Boolean).join("\n")
  );
  return { smsText, reportText, reportMode, launchLine, streak };
}

// Exported for unit testing and reuse by the real-time alert path
// (api/update.js), which wants the same "% vs recent-days norm" comparison
// the daily report shows; the Vercel runtime only invokes the default export.
export {
  buildSummary,
  summaryToSms,
  composeReportSms,
  reportFallbackText,
  sanitizeSmsAscii,
  launchesTodayLine,
  buildBaseline,
  buildDeltas,
  computeProblemStreak,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // ?manual=true: "send me a test report now" from the dashboard button, no
  // CRON_SECRET needed (same no-login philosophy as /api/settings) but real
  // money is spent per send, so it's throttled by its own short cooldown
  // lock instead of trusting a secret. Authorized (cron/secret) callers skip
  // this — they already have a stronger gate.
  const manual = req.query?.manual === "true";
  const authorized = isAuthorized(req);
  if (manual && !authorized) {
    const wonManualLock = await acquireManualReportLock(MANUAL_TEST_COOLDOWN_SEC);
    if (!wonManualLock) {
      return res.status(429).json({
        error: `Test report is rate-limited to once every ${Math.round(MANUAL_TEST_COOLDOWN_SEC / 60)} minutes. Try again shortly.`,
      });
    }
  }

  // Unauthenticated, non-manual read: serve the last stored summary for the
  // dashboard panel.
  if (!authorized && !manual) {
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

  // Authorized (cron / secret) OR a manual test request that just won its
  // cooldown lock: compute, text, store.
  try {
    // ?force=true bypasses BOTH idempotency layers — deliberate double-send
    // for previewing the report format. A manual test always forces a fresh
    // send (that's the point of asking for one "whenever you want").
    const force = req.query?.force === "true" || manual;

    // Idempotency, two layers: a fast read check, then an atomic SET NX lock
    // so even two simultaneous triggers can't both send.
    const existing = await getDailySummary();
    if (!force && existing && Date.now() - Number(existing.generatedAt || 0) < RESEND_GUARD_MS) {
      // Self-healing resend: smsDelivered === false means a recent run built
      // the report but no channel accepted it (provider blip, bad creds).
      // Re-send the ALREADY-STORED text — no regeneration, no history append —
      // so the second cron slot (or a manual trigger) recovers the day's text.
      // Older records predate the flag (undefined) and are treated as delivered.
      if (existing.smsDelivered === false && isSmsConfigured()) {
        const retryText = existing.smsText || existing.plainText || "";
        const retry = await sendSms(retryText);
        if (retry.sent > 0) {
          const updated = await markDailySummaryDelivered();
          return res.status(200).json({
            ...(updated || { ...existing, smsDelivered: true }),
            retriedSms: true,
            sms: { configured: retry.configured, sent: retry.sent, failures: retry.failures, provider: retry.provider },
          });
        }
        return res.status(200).json({
          ...existing,
          retriedSms: true,
          sms: { configured: retry.configured, sent: 0, failures: retry.failures, provider: retry.provider },
        });
      }
      return res.status(200).json({ ...existing, skipped: "recently generated" });
    }
    if (!force) {
      const wonLock = await acquireDailySummaryLock(RESEND_GUARD_MS / 1000);
      if (!wonLock) {
        return res.status(200).json({ ...(existing || {}), skipped: "another run holds the lock" });
      }
    }

    const [history, prevSummaries, storedSettings] = await Promise.all([
      getHistory(288), // up to ~48h @ 10min, we filter to 24h
      getDailySummaryHistory(14), // prior days' summaries → % vs norm
      getSettings().catch(() => ({})), // owner-adjusted alarm limits
    ]);
    const baseline = buildBaseline(prevSummaries);
    const thresholds = getEffectiveThresholds(storedSettings);
    const environmentType = getEffectiveEnvironmentType(storedSettings);
    const summary = buildSummary(history, thresholds, environmentType);

    // Launch schedule and site outlook are enrichment — never let either
    // block the report. fetchLc36Outlook returns null on failure by design.
    let launches = null;
    let outlook = null;
    try {
      [launches, outlook] = await Promise.all([
        getCapeLaunches().catch((err) => {
          console.error("daily-summary: launches fetch failed:", err?.message || err);
          return null;
        }),
        fetchLc36Outlook(),
      ]);
    } catch (err) {
      console.error("daily-summary: enrichment fetch failed:", err?.message || err);
    }

    const { smsText, reportText, reportMode, launchLine, streak } = await composeReportSms(summary, launches, baseline, outlook, prevSummaries);

    // Store BEFORE sending: /api/report-card (and /report, the page the SMS
    // links to) read the latest stored summary, and both ClickSend (MMS
    // media_file) and ntfy (Attach) fetch that URL synchronously while
    // handling the send below — sending first would have them race the
    // write and pick up yesterday's numbers.
    let stored = await putDailySummary({
      ...summary,
      baseline,
      deltas: buildDeltas(summary, baseline),
      forecast: outlook,
      smsText,
      reportText,
      reportMode,
      launchLine,
      problemStreakDays: streak?.streakDays ?? 0,
      justRecovered: streak?.justRecovered ?? false,
      plainText: summaryToSms(summary, baseline),
      smsDelivered: null,
    });

    // Visual report card: text-only SMS providers ignore this, but ClickSend
    // MMS attaches it and the ntfy push renders it, opening the dashboard on tap.
    const smsResult = await sendSms(smsText, {
      imageUrl: `${PUBLIC_BASE_URL}/api/report-card?format=png`,
      clickUrl: PUBLIC_BASE_URL,
    });
    // false arms the retry path above; null means "nothing to retry" (no
    // channel configured at all, so a resend attempt would be pointless).
    if (smsResult.configured) {
      stored = (await markDailySummaryDelivered(smsResult.sent > 0)) || stored;
    }

    return res.status(200).json({
      ...stored,
      sms: { configured: smsResult.configured, sent: smsResult.sent, failures: smsResult.failures, provider: smsResult.provider },
    });
  } catch (err) {
    console.error("daily-summary generate error:", err);
    return res.status(500).json({ error: "summary error" });
  }
}
