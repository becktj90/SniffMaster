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
  getPendingCommand,
} from "../lib/store.js";
import {
  normalizeReading,
  baselineGasR,
  evaluateBreaches,
  getEffectiveThresholds,
  getEffectiveEnvironmentType,
  getEffectiveAlertCooldownMs,
  nearAlertThreshold,
  GAS_BASE_REFRESH_MS,
} from "../lib/thresholds.js";
import { buildHomePayload } from "./extras.js";
import { toGuestView, decideGuestAlerts, publishGuestAlerts, guestTopic } from "../lib/guest.js";
import { getJsonCache, setJsonCache } from "../lib/store.js";
import { loadSubscribers, runSubscriberAlerts } from "../lib/subscribers.js";
import { sendSms, PUBLIC_BASE_URL, REPORT_CARD_PNG_URL } from "../lib/notify.js";
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

  // Gate: the history read below is the expensive part of this path, and the
  // common case is all-clear. Only do a full evaluation when the snapshot is
  // within a margin of a threshold or a breach is already active — otherwise
  // evaluateBreaches would return [] and the persisted state would be
  // unchanged, so skipping is behavior-identical (see nearAlertThreshold).
  // A failed state read forces the full path rather than risking a skip.
  let state = null;
  try {
    state = await getAlertState();
  } catch (err) {
    console.error("alerts: alert-state fetch failed:", err);
  }
  if (state && !nearAlertThreshold(reading, thresholds, environmentType, state)) return;
  if (!state) state = { activeKeys: [], sentAt: {} };

  // History returns newest-first and already includes the just-stored entry;
  // drop it so the baseline reflects the recent past, not the current reading.
  let priorHistory = [];
  try {
    const recent = await getHistory(25);
    priorHistory = Array.isArray(recent) ? recent.slice(1) : [];
  } catch (err) {
    console.error("alerts: history fetch failed:", err);
  }

  const base = baselineGasR(priorHistory);
  const breaches = evaluateBreaches(reading, base, thresholds, environmentType);

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

    // Personal-voice summary only when a breach newly trips — re-notifies
    // past cooldown get the breach lines + report link without it — and
    // bounded at 2.5 s so a slow OpenAI call never holds up the device's
    // POST response (buildAlertBroSummary falls back to a deterministic line
    // on timeout/error, so the alert always ships).
    let broLine = "";
    if (toNotify.some((b) => b.isNew)) {
      try {
        broLine = await buildAlertBroSummary(toNotify, { environmentType, timeoutMs: 2500 });
      } catch (err) {
        console.error("alerts: bro summary failed:", err);
      }
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
        imageUrl: REPORT_CARD_PNG_URL,
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
  // timestamps for cleared breaches, and skip the store write entirely when
  // nothing changed — the common all-clear -> all-clear path costs no quota.
  const activeKeys = breaches.map((b) => b.key).sort();
  const prunedSentAt = {};
  for (const key of activeKeys) {
    if (sentAt[key]) prunedSentAt[key] = sentAt[key];
  }
  // Gas baseline: refresh the stored value when it is missing/stale or has
  // drifted >10% since it was stored, so the ingest gate keeps a trustworthy
  // baseline without a store write on every post.
  const prevBase = Number(state.gasBase);
  const prevBaseAt = Number(state.gasBaseAt);
  const nextBase = Number.isFinite(base) ? base : prevBase;
  const baseStale =
    !Number.isFinite(prevBase) || !Number.isFinite(prevBaseAt) || now - prevBaseAt > GAS_BASE_REFRESH_MS;
  const baseDrifted =
    Number.isFinite(prevBase) && Number.isFinite(nextBase) && Math.abs(nextBase - prevBase) / prevBase > 0.1;
  const gasBaseChanged = Number.isFinite(nextBase) && (baseStale || baseDrifted);
  const changed =
    JSON.stringify(activeKeys) !== JSON.stringify([...prevActive].sort()) ||
    JSON.stringify(prunedSentAt) !== JSON.stringify(state.sentAt) ||
    gasBaseChanged;
  if (changed) {
    await setAlertState({
      activeKeys,
      sentAt: prunedSentAt,
      gasBase: gasBaseChanged ? nextBase : state.gasBase,
      gasBaseAt: gasBaseChanged ? now : state.gasBaseAt,
    });
  }
}

function healthchecksPingUrl() {
  const raw = String(process.env.HEALTHCHECKS_PING_URL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Tell Healthchecks.io this ingest succeeded. The check alerts through ntfy
 * when pings stop. A Vercel Hobby cron runs at most once a day, so it cannot
 * notice a device that goes quiet this afternoon. Never throws.
 */
async function pingHealthchecks() {
  const url = healthchecksPingUrl();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(2500),
      headers: { "User-Agent": "SniffMaster-update" },
    });
    if (!res.ok) console.error("healthchecks ping status:", res.status);
  } catch (err) {
    console.error("healthchecks ping failed:", err?.message || err);
  }
}

const GUEST_CHECK_EVERY_MS = 5 * 60 * 1000;

/**
 * Guest push alerts (smell / poor air). Checked at most every 5 minutes so the
 * 24h history read does not run on every post; best-effort, never throws.
 */
async function maybeSendGuestAlerts(stored) {
  if (!guestTopic()) return;
  const now = Date.now();
  const gate = await getJsonCache("guest-alert-gate");
  if (gate && now - gate.t < GUEST_CHECK_EVERY_MS) return;
  await setJsonCache("guest-alert-gate", { t: now }, 600);
  const payload = await buildHomePayload("");
  if (!payload) return;
  const state = (await getJsonCache("guest-alert-state")) || {};
  const { messages, state: next } = decideGuestAlerts(toGuestView(payload), state, now);
  if (messages.length) await publishGuestAlerts(messages);
  if (JSON.stringify(next) !== JSON.stringify(state)) await setJsonCache("guest-alert-state", next, 24 * 3600);
}

const SUBSCRIBER_CHECK_EVERY_MS = 2 * 60 * 1000;

/**
 * Public email/text alert subscribers (see lib/subscribers.js). Checked at
 * most every 2 minutes; best-effort, never throws.
 */
async function maybeSendSubscriberAlerts(stored) {
  // No verified subscribers: skip the ~2 MB home-payload build entirely.
  // Checked before the gate, like the guest gate's early return when no
  // guest topic is configured; one small cached read per post. A store
  // failure reads as empty here, which loses nothing — the build below
  // needs the store too, so alerts can't run without it anyway.
  const subs = await loadSubscribers().catch(() => []);
  if (!subs.filter((s) => s.verified).length) return;
  const now = Date.now();
  const gate = await getJsonCache("subscriber-alert-gate");
  if (gate && now - gate.t < SUBSCRIBER_CHECK_EVERY_MS) return;
  await setJsonCache("subscriber-alert-gate", { t: now }, 600);
  const payload = await buildHomePayload("");
  await runSubscriberAlerts(stored, payload || {});
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

  const commandAfter = Number(body.commandAfter || 0);
  const data = sanitizePostedBody(body);
  delete data.commandAfter;

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
    try {
      await maybeSendGuestAlerts(stored);
    } catch (guestErr) {
      console.error("maybeSendGuestAlerts error:", guestErr);
    }
    try {
      await maybeSendSubscriberAlerts(stored);
    } catch (subErr) {
      console.error("maybeSendSubscriberAlerts error:", subErr);
    }
    const [command] = await Promise.all([
      getPendingCommand(commandAfter).catch((err) => {
        console.error("pending command read failed:", err);
        return null;
      }),
      pingHealthchecks(),
    ]);
    return res.status(200).json({ ok: true, receivedAt: stored.receivedAt, command });
  } catch (err) {
    console.error("putSnapshot error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
