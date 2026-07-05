/**
 * POST /api/update — receives sensor snapshots from the ESP32
 *
 * Expected JSON body:
 * {
 *   "key": "<SNIFFMASTER_API_KEY>",
 *   "voc": 0.5, "iaq": 25, "iaqAcc": 3, "co2": 420,
 *   "tempF": 72.5, "humidity": 45.2, "pressHpa": 1013.25,
 *   "gasR": 180000, "dVoc": 0.1, "airScore": 85, "tier": 1,
 *   "cfiScore": 0.92, "cfiPercent": 92, "cfiBand": "Peak",
 *   "vtrLevel": 0, "vtrLabel": "Safe", "vtrAdvice": "...",
 *   "fartCount": 3,
 *   "odors": [0,0,...],        // 20 uint8 scores
 *   "primary": "Clean Air", "primaryConf": 0,
 *   "hazard": "Fresh", "sassy": "...", "quip": "...", "radar": "...",
 *   "uptime": 3600, "outdoorAqi": 42, "city": "Kent"
 * }
 */

import { requireDeviceAuth, sanitizePostedBody } from "../lib/auth.js";
import {
  putSnapshot,
  putBleOccupancyEntry,
  getHistory,
  getAlertState,
  setAlertState,
  getSettings,
  getDailySummaryHistory,
  putAlertSnapshot,
} from "../lib/store.js";
import {
  normalizeReading,
  baselineGasR,
  evaluateBreaches,
  getEffectiveThresholds,
  getEffectiveEnvironmentType,
  getEffectiveAlertCooldownMs,
} from "../lib/thresholds.js";
import { sendSms, PUBLIC_BASE_URL } from "../lib/notify.js";
import { buildAlertBroSummary, sanitizeSmsAscii } from "../lib/brogpt.js";
import { buildSummary, buildBaseline, buildDeltas } from "./daily-summary.js";
import { fetchLc36Outlook } from "../lib/forecast.js";

function etTimeLabel(ts) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts)) + " ET";
  } catch {
    return new Date(ts).toISOString();
  }
}

/**
 * Evaluate thresholds for the just-stored snapshot and text the owner when a
 * breach newly appears (or an ongoing breach passes its cooldown). Never throws
 * — a notification failure must not break device ingestion.
 */
async function maybeSendAlerts(stored) {
  const reading = normalizeReading(stored);

  // History returns newest-first and already includes the just-stored entry;
  // drop it so the baseline reflects the recent past, not the current reading.
  let priorHistory = [];
  try {
    const recent = await getHistory(25);
    priorHistory = Array.isArray(recent) ? recent.slice(1) : [];
  } catch (err) {
    console.error("alerts: history fetch failed:", err);
  }

  // Owner-adjustable limits (humidity/temp/etc) + environment preset + alert
  // cooldown; falls back to defaults on any error.
  let thresholds;
  let environmentType;
  let cooldownMs;
  try {
    const settings = await getSettings();
    thresholds = getEffectiveThresholds(settings);
    environmentType = getEffectiveEnvironmentType(settings);
    cooldownMs = getEffectiveAlertCooldownMs(settings);
  } catch (err) {
    console.error("alerts: settings fetch failed, using defaults:", err);
    thresholds = getEffectiveThresholds();
    environmentType = getEffectiveEnvironmentType();
    cooldownMs = getEffectiveAlertCooldownMs();
  }

  const base = baselineGasR(priorHistory);
  const breaches = evaluateBreaches(reading, base, thresholds, environmentType);

  const state = await getAlertState();
  const prevActive = new Set(state.activeKeys);
  const sentAt = { ...state.sentAt };
  const now = Date.now();

  // isNew rides along on each breach (not just the filter decision) so the
  // alert wording can say "still going" vs "just tripped" instead of reading
  // identically whether this is the first minute of a breach or the fifth
  // re-notify after cooldown.
  const toNotify = breaches
    .map((b) => ({ ...b, isNew: !prevActive.has(b.key) }))
    .filter((b) => {
      const cooledDown = !sentAt[b.key] || now - sentAt[b.key] > cooldownMs;
      return b.isNew || cooledDown;
    });

  if (toNotify.length > 0) {
    // One simple message: header + a personal-voice ("bro") summary + the
    // breach lines + a link to the full visual report (/report — 24h stats
    // vs the recent-days baseline, the LC-36 weather/lightning outlook, etc).
    // The detailed numbers used to be dumped as raw text in a second message;
    // now they live on that page instead, so the text itself stays a simple
    // summary. Sent as an MMS with the report-card image when ClickSend is
    // configured. Every piece degrades independently (OpenAI absent/slow,
    // history fetch failure, weather outage, etc.) so the alert always ships.
    const header = `SniffMaster ALERT (${etTimeLabel(reading.receivedAt)})`;
    const lines = toNotify.map((b) => `- ${b.message}`);

    let broLine = "";
    try {
      broLine = await buildAlertBroSummary(toNotify, { environmentType });
    } catch (err) {
      console.error("alerts: bro summary failed:", err);
    }

    // Still compute + store a fresh snapshot so /report and the MMS image
    // reflect THIS alert's numbers (not a stale morning report from hours
    // earlier) — just no longer dumped as text in the message body itself.
    try {
      const [fullHistory, prevSummaries, weather] = await Promise.all([
        getHistory(288), // up to ~48h @ 10min, filtered to 24h inside buildSummary
        getDailySummaryHistory(14), // prior days' summaries -> % vs norm, same as the morning report
        fetchLc36Outlook().catch((err) => {
          console.error("alerts: weather fetch failed:", err?.message || err);
          return null;
        }),
      ]);
      const summary = buildSummary(fullHistory, thresholds, environmentType);
      const baseline = buildBaseline(prevSummaries);
      await putAlertSnapshot({ ...summary, deltas: buildDeltas(summary, baseline), forecast: weather });
    } catch (err) {
      console.error("alerts: snapshot store failed:", err);
    }

    const message = sanitizeSmsAscii(
      [header, broLine, lines.join("\n"), `Full report: ${PUBLIC_BASE_URL}/report`].filter(Boolean).join("\n")
    );

    try {
      const result = await sendSms(message, {
        imageUrl: `${PUBLIC_BASE_URL}/api/report-card?format=png`,
        clickUrl: `${PUBLIC_BASE_URL}/report`,
      });
      if (result.configured && result.sent > 0) {
        for (const b of toNotify) sentAt[b.key] = now;
      }
    } catch (err) {
      console.error("alerts: sendSms failed:", err);
    }
  }

  // Persist the current breach set for next-run comparison. Prune cooldown
  // timestamps for cleared breaches, and skip the Redis write entirely when
  // nothing changed — the common all-clear -> all-clear path costs no quota.
  const activeKeys = breaches.map((b) => b.key).sort();
  const prunedSentAt = {};
  for (const key of activeKeys) {
    if (sentAt[key]) prunedSentAt[key] = sentAt[key];
  }
  const changed =
    JSON.stringify(activeKeys) !== JSON.stringify([...prevActive].sort()) ||
    JSON.stringify(prunedSentAt) !== JSON.stringify(state.sentAt);
  if (changed) {
    await setAlertState({ activeKeys, sentAt: prunedSentAt });
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "JSON body required" });
  }

  if (!requireDeviceAuth(req, res)) return;

  const data = sanitizePostedBody(body);

  try {
    const stored = await putSnapshot(data);
    // Persist BLE occupancy snapshot when device sends occupancy data
    if (typeof data.bleDeviceCount === "number" || typeof data.bleOccupancyIndex === "number") {
      try {
        await putBleOccupancyEntry({ ...data, receivedAt: stored.receivedAt });
      } catch (bleErr) {
        console.error("putBleOccupancyEntry error:", bleErr);
      }
    }
    // Threshold alerting — best-effort, must never block the device response.
    try {
      await maybeSendAlerts(stored);
    } catch (alertErr) {
      console.error("maybeSendAlerts error:", alertErr);
    }
    return res.status(200).json({ ok: true, receivedAt: stored.receivedAt });
  } catch (err) {
    console.error("putSnapshot error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
