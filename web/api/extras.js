/**
 * /api/extras — dispatcher for secondary/novelty endpoints.
 *
 * Vercel's Hobby plan caps a deployment at 12 serverless functions; `web/api`
 * had grown to 15 files. These 8 lower-traffic routes are combined into this
 * single function (dispatched by the `fn` query param) to stay well under the
 * cap, while every external URL keeps working unchanged via the rewrites in
 * vercel.json (e.g. `/api/apod` → `/api/extras?fn=apod`). Each route's logic
 * below is unmodified from its original standalone file — only regrouped, with
 * a few identical helper functions (num/clamp/extractOutputText/
 * OPENAI_RESPONSES_URL) de-duplicated since this file now defines them once.
 *
 * Routes: apod, command, launches, occupancy-briefing, office-stats,
 * sniff-stream, weather-briefing.
 */

import { requireDeviceAuth } from "../lib/auth.js";
import {
  isStoreConfigured,
  getLatest,
  getLatestBleOccupancy,
  getBleOccupancyHistory,
  getHistory,
  getPendingCommand,
  putCommand,
  getLatestSniff,
  getSettings,
  putSettings,
  getAlertState,
  getDailySummary,
  getAlertSnapshot,
  getJsonCache,
  getJsonCacheStale,
  setJsonCache,
  isReadBreakerTripped,
  incrCounter,
  getHomeSeries,
} from "../lib/store.js";
import { buildReportCardSvg, renderReportCardPng } from "../lib/reportCard.js";
import { buildHomeMetrics, mergeClimateHistory } from "../lib/homeAir.js";
import { toGuestView, guestTopic } from "../lib/guest.js";
import { analyzeCause } from "../lib/causes.js";
import { toOledView } from "../lib/oled.js";
import { analyzeSmell, allergyOutlook, ventilationAdvice, parseTriggers, canonicalSeverities } from "../lib/homeInsights.js";
import { buildAirSense } from "../lib/airSense.js";
import { fetchOutdoor } from "../lib/outdoor.js";
import { fetchGooglePollen } from "../lib/pollen.js";
import { fetchGoogleAir } from "../lib/googleAir.js";
import { airTile } from "../lib/airTile.js";
import { lookupEnvironment } from "../lib/googleEnv.js";
import {
  getEffectiveThresholds,
  getEffectiveAlertCooldownMs,
  THRESHOLDS,
  THRESHOLD_LIMITS,
  ALERT_COOLDOWN_LIMITS,
  DEFAULT_ALERT_COOLDOWN_MIN,
  ENVIRONMENT_TYPES,
  DEFAULT_ENVIRONMENT_TYPE,
  normalizeEnvironmentType,
  isKnownEnvironmentType,
} from "../lib/thresholds.js";
import { getCapeLaunches, getCached as getCachedLaunches, setCache as setCacheLaunches, fetchLaunches } from "../lib/launches.js";
import { createHash } from "node:crypto";
import { insightFacts, insightCacheKey, claudeInsights, fallbackInsights } from "../lib/insights.js";
import {
  aiInsightFacts,
  aiInsightCacheKey,
  generateAiInsight,
  fallbackInsight,
  resolveInsightCache,
  AI_INSIGHT_TTL_SEC,
  AI_INSIGHT_FALLBACK_TTL_SEC,
} from "../lib/aiInsight.js";
import {
  RULES as SUBSCRIBER_RULES,
  AlertError,
  alertChannels,
  loadSubscribers,
  startSubscription,
  confirmSubscription,
  unsubscribe,
  getSubscriberByToken,
  publicSubscriber,
  updateSubscriberRules,
} from "../lib/subscribers.js";

// ── Shared helpers (identical across the merged files; defined once here) ──
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

// ── apod ─────────────────────────────────────────────────────────────────
// GET /api/apod — NASA Astronomy Picture of the Day, cached 24h in the store,
// falling back to the NASA Image and Video Library (no key required).
const APOD_BASE = "https://api.nasa.gov/planetary/apod";
const APOD_CACHE_KEY = "apod";
const APOD_CACHE_TTL_SEC = 86400; // 24 hours — picture changes once a day
const NASA_IMAGES_BASE = "https://images-api.nasa.gov/search";
const NASA_IMAGES_QUERIES = ["nebula", "galaxy", "aurora", "solar system", "deep space", "supernova", "milky way", "earth from space"];
const APOD_FALLBACK_CACHE_KEY = "apod-fallback";

async function getApodCached(key = APOD_CACHE_KEY) {
  if (!isStoreConfigured()) return null;
  try {
    const data = await getJsonCache(key);
    if (!data) return null;
    // Invalidate if the stored date doesn't match today (UTC)
    const today = new Date().toISOString().slice(0, 10);
    if (data?.date && data.date !== today) return null;
    return data;
  } catch {
    return null;
  }
}

async function setApodCache(data, key = APOD_CACHE_KEY) {
  if (!isStoreConfigured()) return;
  try {
    await setJsonCache(key, data, APOD_CACHE_TTL_SEC);
  } catch {
    // best-effort cache
  }
}

async function fetchApod() {
  const apiKey = `${process.env.NASA_API_KEY || "DEMO_KEY"}`.trim();
  const url = `${APOD_BASE}?api_key=${encodeURIComponent(apiKey)}&thumbs=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "SniffMaster/1.0 (environmental-dashboard)" },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`nasa-apod ${res.status}`);
  const json = await res.json();

  return {
    date: json.date || "",
    title: json.title || "Astronomy Picture of the Day",
    explanation: json.explanation || "",
    url: json.media_type === "video" ? null : (json.url || null),
    hdurl: json.media_type === "video" ? null : (json.hdurl || json.url || null),
    thumbnail: json.thumbnail_url || null,
    mediaType: json.media_type || "image",
    videoUrl: json.media_type === "video" ? json.url : null,
    copyright: json.copyright || null,
    serviceVersion: json.service_version || "v1",
    apodPageUrl: (() => {
      // Build per-day APOD URL: format is ap{YY}{MM}{DD}.html (e.g. ap240101.html)
      const d = `${json.date || ""}`.replace(/-/g, "");
      return d.length === 8 ? `https://apod.nasa.gov/apod/ap${d.slice(2)}.html` : "https://apod.nasa.gov/apod/";
    })(),
  };
}

/**
 * Fallback: fetch a space image from the NASA Image and Video Library.
 * This API requires no key and has no strict rate limits.
 */
async function fetchNasaImageFallback() {
  // Pick a deterministic query based on the day-of-year so it rotates daily
  const today = new Date().toISOString().slice(0, 10);
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 86400000);
  const query = NASA_IMAGES_QUERIES[dayOfYear % NASA_IMAGES_QUERIES.length];
  const url = `${NASA_IMAGES_BASE}?q=${encodeURIComponent(query)}&media_type=image&page_size=20&year_start=2015`;

  const res = await fetch(url, {
    headers: { "User-Agent": "SniffMaster/1.0 (environmental-dashboard)" },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`nasa-images ${res.status}`);
  const json = await res.json();

  const items = json?.collection?.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error("nasa-images empty");

  // Pick a deterministic item based on the day-of-year so the same image shows all day
  const item = items[dayOfYear % items.length];
  const data = Array.isArray(item.data) ? item.data[0] : {};
  const thumbLink = Array.isArray(item.links) ? item.links.find(l => l.rel === "preview") : null;
  const thumbUrl = thumbLink?.href || null;

  // Construct a larger image URL from the thumbnail when the standard naming convention is used
  const largeUrl = thumbUrl && /~thumb\.jpg$/i.test(thumbUrl)
    ? thumbUrl.replace(/~thumb\.jpg$/i, "~large.jpg")
    : thumbUrl;

  return {
    date: today,
    title: data.title || "NASA Space Image",
    explanation: data.description || "",
    url: largeUrl,
    hdurl: largeUrl,
    thumbnail: thumbUrl,
    mediaType: "image",
    videoUrl: null,
    copyright: data.photographer || data.secondary_creator || null,
    serviceVersion: "v1",
    apodPageUrl: "https://images.nasa.gov/",
    source: "nasa-images-fallback",
  };
}

async function apod(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // 1. Try the primary APOD cache
  try {
    const cached = await getApodCached(APOD_CACHE_KEY);
    if (cached) {
      return res.status(200).json({ ...cached, source: "cache" });
    }
  } catch {
    // fall through
  }

  // 2. Try live NASA APOD
  try {
    const apodData = await fetchApod();
    await setApodCache(apodData, APOD_CACHE_KEY);
    return res.status(200).json({ ...apodData, source: "live" });
  } catch (apodErr) {
    console.error("apod error:", apodErr);
  }

  // 3. Try the fallback cache (NASA Image Library result from earlier today)
  try {
    const cachedFallback = await getApodCached(APOD_FALLBACK_CACHE_KEY);
    if (cachedFallback) {
      return res.status(200).json({ ...cachedFallback, source: "cache-fallback" });
    }
  } catch {
    // fall through
  }

  // 4. Try live NASA Image Library fallback (no API key required)
  try {
    const fallback = await fetchNasaImageFallback();
    await setApodCache(fallback, APOD_FALLBACK_CACHE_KEY);
    return res.status(200).json({ ...fallback, source: "nasa-images-fallback" });
  } catch (fallbackErr) {
    console.error("nasa-images fallback error:", fallbackErr);
  }

  // 5. Last resort stub — at minimum shows the explanation text
  return res.status(200).json({
    title: "Astronomy Picture of the Day",
    explanation: "Visit apod.nasa.gov for today's astronomy picture.",
    url: null,
    hdurl: null,
    mediaType: "image",
    date: new Date().toISOString().slice(0, 10),
    apodPageUrl: "https://apod.nasa.gov/apod/",
    source: "error",
  });
}

// ── command ──────────────────────────────────────────────────────────────
// GET  — device polls for the newest owner-issued command
// POST — owner queues a new command from the portal
const ALLOWED_ACTIONS = new Set(["refresh", "breath_check", "presence_probe", "gas_scan"]);

function setCommandHeaders(res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
}

async function command(req, res) {
  setCommandHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    if (!requireDeviceAuth(req, res)) return;
    const after = Number(req.query?.after || 0);

    try {
      const latest = await getPendingCommand(after);
      if (!latest) return res.status(204).end();
      return res.status(200).json(latest);
    } catch (err) {
      console.error("getPendingCommand error:", err);
      return res.status(500).json({ error: "storage error" });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "GET/POST only" });
  }

  const action = String(req.body?.action || "").trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: "unsupported action" });
  }

  try {
    const stored = await putCommand({
      action,
      source: "portal",
      note: action === "refresh"
        ? "Manual sync requested from portal"
        : action === "breath_check"
          ? "Breath analysis requested from portal"
          : action === "gas_scan"
            ? "On-demand BME688 heater scan requested from portal"
            : "BLE presence probe requested from portal",
    });
    return res.status(200).json({
      ok: true,
      seq: stored.seq,
      action: stored.action,
      receivedAt: stored.receivedAt,
    });
  } catch (err) {
    console.error("putCommand error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}

// ── launches ─────────────────────────────────────────────────────────────
// GET /api/launches — Cape Canaveral launches, 1h store cache (lib/launches.js)
async function launches(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const cached = await getCachedLaunches();
    if (cached) {
      return res.status(200).json({ launches: cached, source: "cache" });
    }

    const launchList = await fetchLaunches();
    await setCacheLaunches(launchList);
    return res.status(200).json({ launches: launchList, source: "live" });
  } catch (err) {
    console.error("launches error:", err);
    return res.status(200).json({ launches: [], source: "error", error: err?.message || String(err) });
  }
}

// ── occupancy-briefing ───────────────────────────────────────────────────
// GET /api/occupancy-briefing — BLE occupancy analysis with an AI-generated
// insight (same OpenAI pattern as weather-briefing).
function densityLabel(index) {
  if (index <= 5)  return "Empty";
  if (index <= 25) return "Low";
  if (index <= 55) return "Moderate";
  if (index <= 80) return "Busy";
  return "Packed";
}

function densityNote(index, source, confound) {
  if (confound) {
    return `CO₂ is elevated, but the dominant odor (${confound.label}, ${confound.conf}%) is a likely non-occupancy source — treat this density reading as unreliable until that clears.`;
  }
  const co2ctx = source === "co2" ? " (derived from CO₂ reading)" : "";
  if (index <= 5)  return `No elevated CO₂ detected. The space appears unoccupied or very well-ventilated${co2ctx}.`;
  if (index <= 25) return `CO₂ is only slightly above ambient. Light occupancy or excellent ventilation${co2ctx}.`;
  if (index <= 55) return `CO₂ at a moderate level consistent with normal occupancy — typical for an active work session${co2ctx}.`;
  if (index <= 80) return `Elevated CO₂ indicates meaningful occupancy. Shared-air buildup is accelerating${co2ctx}.`;
  return `High CO₂ suggests the space is at or near capacity. Ventilate promptly${co2ctx}.`;
}

function deriveTrend(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return { direction: "stable", delta: 0 };
  }
  const latest = num(history[0]?.occupancyIndex);
  const prior  = num(history[1]?.occupancyIndex);
  const delta  = latest - prior;
  const direction = delta > 5 ? "rising" : delta < -5 ? "falling" : "stable";
  return { direction, delta };
}

const CO2_BASELINE_PPM   = 400; // outdoor ambient
const CO2_PPM_PER_INDEX  = 12;  // ~12 ppm per index point → 100 at 1 600 ppm

function co2ToOccupancyIndex(co2) {
  if (!co2 || co2 < 350) return 0;
  return clamp(Math.round((co2 - CO2_BASELINE_PPM) / CO2_PPM_PER_INDEX), 0, 100);
}

// The CO2 fallback assumes elevated CO2 = people breathing. That assumption
// breaks when the classifier's dominant odor is a combustion/chemical/food
// source (e.g. cooking) rather than body odor — those VOCs push CO2 up too,
// so a stove left on in an empty room would otherwise read as "12 people".
// Only "Sweat/BO" and "Fart" are genuinely presence-linked; everything else
// in ODOR_NAMES (mirrored from app.js) confounds the CO2-based estimate.
const PRESENCE_LINKED_ODORS = new Set(["Sweat/BO", "Fart"]);
const CONFOUND_CONFIDENCE_MIN = 40; // matches app.js's "confident" bar

function occupancyConfound(snapshot) {
  const label = snapshot?.primary;
  const conf = num(snapshot?.primaryConf, NaN);
  if (!label || label === "Clean Air" || PRESENCE_LINKED_ODORS.has(label)) return null;
  if (!Number.isFinite(conf) || conf < CONFOUND_CONFIDENCE_MIN) return null;
  return { label, conf: Math.round(conf) };
}

function buildCo2History(sensorHistory) {
  if (!Array.isArray(sensorHistory)) return [];
  return sensorHistory
    .filter((h) => num(h.co2) > 0)
    .map((h) => ({
      occupancyIndex: co2ToOccupancyIndex(num(h.co2)),
      co2: num(h.co2),
      receivedAt: h.receivedAt || null,
    }));
}

function occupancyFallbackBriefing(index, deviceCount, trend, snapshot, source, confound) {
  const label = densityLabel(index);
  const trendStr = trend.direction === "rising"
    ? "and occupancy is climbing"
    : trend.direction === "falling"
      ? "and occupancy is declining"
      : "with stable occupancy";
  const co2 = num(snapshot?.co2);
  if (source === "co2" && co2 > 0) {
    if (confound) {
      return `CO₂ is elevated at ${Math.round(co2)} ppm, but the dominant odor right now is ${confound.label} (${confound.conf}% confidence) — that's a likely non-occupancy source, so this reading probably overstates how many people are actually present.`;
    }
    return `${label} occupancy (index ${index}) estimated from CO₂ at ${Math.round(co2)} ppm ${trendStr}. CO₂ is a reliable proxy for room occupancy — elevated readings indicate more people or reduced ventilation.`;
  }
  const co2Line = co2 > 900
    ? ` CO2 is elevated at ${Math.round(co2)} ppm — consistent with the detected occupancy load.`
    : co2 > 0
      ? ` CO2 is at ${Math.round(co2)} ppm, which aligns with current occupancy.`
      : "";
  return `${label} occupancy (index ${index}) with ${deviceCount} BLE device${deviceCount !== 1 ? "s" : ""} detected ${trendStr}.${co2Line}`;
}

async function generateOpenAiBriefing(occupancyData, snapshot, trend, fallback, source, confound) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey) return null;

  const model = `${process.env.OPENAI_OCCUPANCY_MODEL || process.env.OPENAI_WEATHER_MODEL || "gpt-5.4-nano"}`.trim();
  const index    = num(occupancyData?.occupancyIndex);
  const devices  = num(occupancyData?.deviceCount);
  const avgRssi  = num(occupancyData?.avgRssi, NaN);
  const co2      = num(snapshot?.co2);
  const iaq      = num(snapshot?.iaq);
  const tempF    = num(snapshot?.tempF);
  const humidity = num(snapshot?.humidity);
  const trendStr = trend.direction;

  const sourceNote = source === "co2"
    ? confound
      ? `Occupancy is estimated from CO₂ (${Math.round(co2)} ppm), but the dominant detected odor is ${confound.label} (${confound.conf}% confidence) — a non-occupancy source that also raises CO2/VOC readings, so this estimate is likely overstated. Say so plainly rather than giving a confident people count.`
      : `Occupancy is estimated from CO₂ (${Math.round(co2)} ppm). CO₂ above ~400 ppm ambient indicates people are present.`
    : `${devices} BLE device(s) detected.${Number.isFinite(avgRssi) ? ` Average signal: ${Math.round(avgRssi)} dBm.` : ""}`;

  const prompt = [
    "Write a concise occupancy insight for a professional indoor air quality and space management dashboard.",
    "Keep it to 2 or 3 sentences, under 80 words.",
    "Focus on occupancy level, any air quality implications, and actionable ventilation or density guidance.",
    "Do not be chatty or mention AI.",
    `Current occupancy index: ${index}/100 (${densityLabel(index)}), trend: ${trendStr}.`,
    sourceNote,
    co2 > 0 ? `Indoor CO2: ${Math.round(co2)} ppm, IAQ: ${Math.round(iaq)}, Temp: ${Math.round(tempF)}F, Humidity: ${Math.round(humidity)}%.` : "",
    `Fallback: ${fallback}`,
  ].filter(Boolean).join("\n");

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 130,
    }),
  });

  if (!res.ok) throw new Error(`openai ${res.status}`);

  const json = await res.json();
  const text = extractOutputText(json);
  return text || null;
}

async function occupancyBriefing(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  try {
    const [bleEntry, snapshot, bleHistory, sensorHistory] = await Promise.all([
      getLatestBleOccupancy(),
      getLatest(),
      getBleOccupancyHistory(48),
      getHistory(48),
    ]);

    // Return 204 if no data at all
    if (!bleEntry && !snapshot) return res.status(204).end();

    // Determine source: prefer BLE if available, otherwise fall back to CO₂
    const co2 = num(snapshot?.co2);
    const hasBle = Boolean(bleEntry || num(snapshot?.bleDeviceCount));
    const source = hasBle ? "ble" : co2 > 0 ? "co2" : "none";

    let index, devices, avgRssi, strongest, history;

    if (source === "ble") {
      // Merge: prefer dedicated BLE entry; fall back to fields in the latest snapshot
      const entry = bleEntry || {
        deviceCount:     num(snapshot?.bleDeviceCount),
        occupancyIndex:  num(snapshot?.bleOccupancyIndex),
        avgRssi:         num(snapshot?.bleAvgRssi, NaN),
        strongestRssi:   num(snapshot?.bleStrongestRssi, NaN),
        seenRecently:    Boolean(snapshot?.bleSeenRecently),
        enabled:         Boolean(snapshot?.blePresenceEnabled),
        receivedAt:      snapshot?.receivedAt || null,
      };
      index    = clamp(num(entry.occupancyIndex), 0, 100);
      devices  = Math.max(0, num(entry.deviceCount));
      avgRssi  = num(entry.avgRssi, NaN);
      strongest = num(entry.strongestRssi, NaN);
      history  = bleHistory.slice(0, 48).map((h) => ({
        occupancyIndex: num(h.occupancyIndex),
        deviceCount:    num(h.deviceCount),
        co2:            null,
        receivedAt:     h.receivedAt || null,
      }));
    } else if (source === "co2") {
      // CO₂-based occupancy: index saturates at ~1600 ppm
      index    = co2ToOccupancyIndex(co2);
      devices  = 0;
      avgRssi  = NaN;
      strongest = NaN;
      history  = buildCo2History(sensorHistory).slice(0, 48);
    } else {
      return res.status(204).end();
    }

    // Only meaningful for the CO2 fallback — BLE-derived counts don't ride on
    // the odor classifier at all.
    const confound = source === "co2" ? occupancyConfound(snapshot) : null;

    const trend   = deriveTrend(history.length >= 2 ? history : []);
    const fallback = occupancyFallbackBriefing(index, devices, trend, snapshot, source, confound);

    let briefing = fallback;
    let mode = "deterministic";

    try {
      const occupancyData = { occupancyIndex: index, deviceCount: devices, avgRssi };
      const aiBriefing = await generateOpenAiBriefing(occupancyData, snapshot, trend, fallback, source, confound);
      if (aiBriefing) {
        briefing = aiBriefing;
        mode = "openai";
      }
    } catch (err) {
      console.error("occupancy-briefing openai error:", err);
    }

    return res.status(200).json({
      occupancyIndex:  index,
      deviceCount:     devices,
      avgRssi:         Number.isFinite(avgRssi)   ? Math.round(avgRssi)   : null,
      strongestRssi:   Number.isFinite(strongest) ? Math.round(strongest) : null,
      seenRecently:    source === "ble" ? Boolean(snapshot?.bleSeenRecently) : true,
      enabled:         true,
      densityLabel:    densityLabel(index),
      densityNote:     densityNote(index, source, confound),
      source,
      confound,
      co2Reading:      co2 > 0 ? Math.round(co2) : null,
      trend,
      history:         history.slice(0, 48).map((h) => ({
        occupancyIndex: num(h.occupancyIndex),
        deviceCount:    num(h.deviceCount),
        co2:            h.co2 || null,
        receivedAt:     h.receivedAt || null,
      })),
      briefing,
      mode,
      receivedAt:      snapshot?.receivedAt || null,
      generatedAt:     Date.now(),
    });
  } catch (err) {
    console.error("occupancy-briefing error:", err);
    return res.status(500).json({ error: "occupancy briefing error" });
  }
}

// ── office-stats ─────────────────────────────────────────────────────────
// GET /api/office-stats — office-oriented derived room metrics (focus and
// ventilation-risk heuristics from the latest snapshot).
function deriveCfiScore(snapshot) {
  const explicit = num(snapshot?.cfiScore, NaN);
  if (Number.isFinite(explicit)) return clamp(explicit, 0, 1);
  let score = 1;
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  if (co2 > 800) score -= ((co2 - 800) / 100) * 0.05;
  if (iaq > 100) score -= 0.10;
  return clamp(score, 0, 1);
}

function deriveCfiPercent(snapshot) {
  const explicit = num(snapshot?.cfiPercent, NaN);
  if (Number.isFinite(explicit)) return Math.round(clamp(explicit, 0, 100));
  return Math.round(deriveCfiScore(snapshot) * 100);
}

function deriveCfiBand(snapshot) {
  const explicit = `${snapshot?.cfiBand || ""}`.trim();
  if (explicit) return explicit;
  const percent = deriveCfiPercent(snapshot);
  if (percent >= 80) return "Peak";
  if (percent >= 60) return "Reduced";
  return "Drained";
}

function deriveVtrLevel(snapshot) {
  const explicit = num(snapshot?.vtrLevel, NaN);
  if (Number.isFinite(explicit)) return clamp(Math.round(explicit), 0, 2);
  const humidity = num(snapshot?.humidity);
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  if (humidity < 30 && co2 > 1200) return 2;
  if (humidity >= 40 && humidity <= 60 && co2 < 800 && iaq <= 100) return 0;
  return 1;
}

function deriveVtrLabel(level) {
  if (level === 0) return "Safe";
  if (level === 2) return "High Bio-Risk";
  return "Elevated";
}

function deriveVtrAdvice(level) {
  if (level === 0) return "Ventilation and humidity are in a favorable range.";
  if (level === 2) return "Dry, rebreathed air pattern detected. Air cleaning, filtration, or masking is recommended.";
  return "Stagnant or dry air detected. Increase ventilation.";
}

function deriveAttention(snapshot) {
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  const temp = num(snapshot?.tempF);
  const voc = num(snapshot?.voc);
  const dVoc = Math.abs(num(snapshot?.dVoc));
  let score = 0;

  if (co2 > 1200) score += 2;
  else if (co2 > 950) score += 1;
  else if (co2 > 800) score += 0.5;
  if (iaq > 120) score += 1;
  else if (iaq > 80) score += 0.5;
  if (temp > 79 || temp < 67) score += 0.75;
  else if (temp > 77 || temp < 69) score += 0.35;
  if (voc > 1.2 || dVoc > 0.25) score += 0.5;

  if (score >= 3) return { title: "Heavy drag", note: "Expect concentration to decay faster and routine work to feel more expensive than it should." };
  if (score >= 1.5) return { title: "Moderate drag", note: "Attention is still workable, but the room is starting to tax patience, clarity, or pace." };
  return { title: "Low drag", note: "Air conditions are not likely to be the main thing slowing people down right now." };
}

function deriveComfort(snapshot) {
  const temp = num(snapshot?.tempF);
  const humidity = num(snapshot?.humidity);
  if (humidity < 30) return { title: "Dry air load", note: "Low humidity can dry out eyes and throat, which makes long desk sessions feel harsher than the room looks." };
  if (humidity > 65) return { title: "Sticky air", note: "High humidity makes the room feel heavier and can amplify perceived stuffiness in meetings." };
  if (temp > 79) return { title: "Running warm", note: "Warm rooms tend to sap alertness and make shared spaces feel sluggish faster." };
  if (temp < 67) return { title: "Running cool", note: "A cool room can stay usable, but some people will feel it as distraction rather than freshness." };
  return { title: "Comfortable band", note: "Temperature and humidity are in a range that should stay easy to inhabit for longer work blocks." };
}

function deriveCollaboration(snapshot) {
  const co2 = num(snapshot?.co2);
  const iaq = num(snapshot?.iaq);
  if (co2 > 1400 || iaq > 130) return { title: "Stale room load", note: "This is the kind of air that makes group work feel slow, repetitive, and less patient than it should." };
  if (co2 > 1000 || iaq > 90) return { title: "Shared-air heavy", note: "The room is still workable, but longer meetings will feel flatter unless you give it some turnover." };
  if (co2 > 800) return { title: "Occupied but workable", note: "There is some rebreathed-air buildup, though the room is still in decent shape for normal collaboration." };
  return { title: "Meeting ready", note: "Shared-air load is low enough that the room should feel clear and easier to work in." };
}

function deriveOdorDistraction(snapshot) {
  const voc = num(snapshot?.voc);
  const dVoc = Math.abs(num(snapshot?.dVoc));
  const primary = `${snapshot?.primary || ""}`.trim();
  const primaryConf = num(snapshot?.primaryConf);
  const confident = Boolean(primary && primaryConf >= 20);
  if ((confident && primaryConf >= 40) || voc >= 1.5 || dVoc >= 0.35) {
    return { title: confident ? `${primary} is noticeable` : "Air signature is distracting", note: "The room has enough volatile activity that people are more likely to notice the environment, not just the work." };
  }
  if (confident || voc >= 0.9 || dVoc >= 0.18) {
    return { title: confident ? `${primary} in the background` : "Mild sensory load", note: "There is some environmental character in the room, but it should stay secondary unless people are sensitive to smells." };
  }
  return { title: "Easy to ignore", note: "The air is quiet enough that odor should not become part of the conversation." };
}

function deriveBriefing(snapshot, cfiPercent, vtrLevel) {
  const attention = deriveAttention(snapshot);
  const comfort = deriveComfort(snapshot);
  const collab = deriveCollaboration(snapshot);
  const odor = deriveOdorDistraction(snapshot);
  if (vtrLevel >= 2) {
    return "The room is stacking multiple human-cost signals at once: dry shared air, weaker attention conditions, and a higher chance that people feel the space before they say anything about it.";
  }
  if (cfiPercent < 60) {
    return "The main hit right now is cognitive. This room is likely making focus, short-term memory, and meeting patience feel worse than they need to.";
  }
  return `${attention.title}, ${comfort.title.toLowerCase()}, and ${collab.title.toLowerCase()}. ${odor.note}`;
}

async function officeStats(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  try {
    const snapshot = await getLatest();
    if (!snapshot) return res.status(204).end();

    const cfiScore = deriveCfiScore(snapshot);
    const cfiPercent = deriveCfiPercent(snapshot);
    const cfiBand = deriveCfiBand(snapshot);
    const vtrLevel = deriveVtrLevel(snapshot);
    const attention = deriveAttention(snapshot);
    const comfort = deriveComfort(snapshot);
    const collaboration = deriveCollaboration(snapshot);
    const odorDistraction = deriveOdorDistraction(snapshot);

    return res.status(200).json({
      cfiScore,
      cfiPercent,
      cfiBand,
      vtrLevel,
      vtrLabel: deriveVtrLabel(vtrLevel),
      vtrAdvice: deriveVtrAdvice(vtrLevel),
      attention,
      comfort,
      collaboration,
      odorDistraction,
      briefing: deriveBriefing(snapshot, cfiPercent, vtrLevel),
      co2: num(snapshot.co2),
      iaq: num(snapshot.iaq),
      humidity: num(snapshot.humidity),
      receivedAt: snapshot.receivedAt || null,
      city: snapshot.city || "",
    });
  } catch (err) {
    console.error("office-stats error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}

// ── home-stats ───────────────────────────────────────────────────────────
// GET /api/home-stats — whole-home air-quality, particulate, mold/dust-mite and
// comfort metrics (see lib/homeAir.js), plus free outdoor context (Open-Meteo)
// and capped pollen (Google Pollen API, see lib/pollen.js). Public/read-only,
// like the other dashboard GETs. Never returns any API key.
const HOME_OUTDOOR_TTL_SEC = 15 * 60;

const HOME_PAYLOAD_TTL_SEC = 300;

/**
 * Whole-home payload, cached 300 s per trigger set in the store. This is the hot
 * path: /api/oled, /api/home-stats, /api/guest, /api/insights and both
 * /api/update alert gates all build it, ~4,000×/day, and a fresh build
 * re-reads + re-parses the last 6 h of full history (~0.5 MB) every time. A 5-minute
 * stale window is cheap at the dashboard's 2-minute poll and the device's
 * 1-minute post cadence — readings are 1-minute cadence, so the payload is
 * at most a few minutes stale — and a cache miss rebuilds identically.
 */
export async function buildHomePayload(triggersInput, severitiesInput) {
  // The severity string is part of the cache key: two devices with the same
  // triggers but different severities get different outlooks.
  const sevKey = canonicalSeverities(severitiesInput);
  const key = `home-payload:${parseTriggers(triggersInput).join(",") || "none"}|${sevKey || "std"}`;
  // Read-cap breaker (free-plan guardrail): when the month's rows read hit
  // 80% of Turso's free-tier cap, serve the last cached payload — even past
  // its TTL — instead of re-reading history. Checked BEFORE the cache
  // lookup because getJsonCache deletes expired rows on a miss, which would
  // destroy the stale payload we need to serve. With no cached payload to
  // serve, return null rather than spend reads on a rebuild.
  try {
    if (await isReadBreakerTripped()) {
      const stale = await getJsonCacheStale(key);
      if (stale) return { ...stale, breakerTripped: true, stale: true };
      return null;
    }
  } catch {}
  try {
    const hit = await getJsonCache(key);
    if (hit) return hit;
  } catch {}
  const payload = await buildHomePayloadFresh(triggersInput, severitiesInput);
  if (payload) {
    try {
      await setJsonCache(key, payload, HOME_PAYLOAD_TTL_SEC);
    } catch {}
  }
  return payload;
}

async function buildHomePayloadFresh(triggersInput, severitiesInput) {
    const triggers = parseTriggers(triggersInput);
    // Full snapshots cover the last 6h (free-plan retention cut, Nov 2026).
    // Mold (72h) and dust mites (7d) read the compact 10-minute series,
    // which survives after the full buffer rolls.
    const [latest, legacy, series] = await Promise.all([
      getLatest(),
      getHistory(390),
      getHomeSeries(),
    ]);
    if (!latest) return null;
    const history = mergeClimateHistory(series.coarse, legacy, series.fine);

    const lat = Number(latest.lat);
    const lon = Number(latest.lon);
    const haveLoc = Number.isFinite(lat) && Number.isFinite(lon);

    // Outdoor context: Open-Meteo is free + keyless; cached 15 min per ~11 km cell.
    let outdoor = null;
    let pollen = null;
    if (haveLoc) {
      const cell = `outdoor:${lat.toFixed(1)}:${lon.toFixed(1)}`;
      try {
        const hit = await getJsonCache(cell);
        if (hit) ({ outdoor, pollen } = hit);
      } catch {}
      if (!outdoor) {
        ({ outdoor, pollen } = await fetchOutdoor({ lat, lon }));
        if (outdoor) {
          try {
            await setJsonCache(cell, { outdoor, pollen }, HOME_OUTDOOR_TTL_SEC);
          } catch {}
        }
      }
      // Only when the free feed has no pollen for this location, fall back to
      // the capped Google Pollen API (cache + monthly cap live in pollen.js).
      if (!pollen) {
        pollen = await fetchGooglePollen(
          { lat, lon },
          { cacheGet: getJsonCache, cacheSet: setJsonCache, incr: incrCounter }
        );
      } else {
        pollen = { ok: true, ...pollen };
      }
    } else {
      pollen = { ok: false, reason: "No device location yet" };
    }

    let googleAir = { ok: false, reason: haveLoc ? "Google air quality unavailable" : "No device location yet" };
    if (haveLoc) {
      try {
        googleAir = await fetchGoogleAir(
          { lat, lon },
          { cacheGet: getJsonCache, cacheSet: setJsonCache, incr: incrCounter }
        );
      } catch (err) {
        console.error("google air:", err?.message || err);
      }
    }

    const metrics = buildHomeMetrics(latest, history, { outdoor, pollen });
    
    const smell = analyzeSmell(latest, legacy);
    const cause = analyzeCause(latest, legacy, { outdoor, pollen });
    const withPollen = { ...metrics, pollen };
    const outlook = allergyOutlook(withPollen, triggers, smell, severitiesInput);
    const ventilation = ventilationAdvice(withPollen, smell, triggers);
    const airSense = buildAirSense({
      latest,
      history: legacy,
      smell,
      cause,
      climate: metrics.climate,
      outdoor: metrics.outdoor || outdoor,
      pollen,
      ventilation,
      gases: metrics.gases,
    });

    // 6 h oldest→newest series for the trend sparklines (the full buffer
    // only keeps 6 h now; older trend data lives in the compact series).
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const rows = history.filter((h) => Number(h?.receivedAt) >= dayAgo);
    const pick = (f) => rows.map((h) => {
      const v = f(h);
      return Number.isFinite(Number(v)) ? Number(v) : null;
    });
    const trend = {
      t: rows.map((h) => Number(h.receivedAt)),
      humidity: pick((h) => h.humidity),
      tempC: pick((h) => h.temperature),
      co2: pick((h) => h.co2),
      iaq: pick((h) => h.iaq),
      pm25: pick((h) => h.pm25),
    };

    return {
      mode: "home",
      receivedAt: latest.receivedAt || null,
      city: latest.city || "",
      located: haveLoc,
      location: haveLoc ? { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 } : null,
      airSample: latest.airSampleState ? {
        state: latest.airSampleState,
        startedAt: Number(latest.airSampleStartedAt) || null,
        progress: Number.isFinite(Number(latest.airSampleProgress)) ? Number(latest.airSampleProgress) : null,
        baselineVoc: Number.isFinite(Number(latest.airSampleBaselineVoc)) ? Number(latest.airSampleBaselineVoc) : null,
        deltaVoc: Number.isFinite(Number(latest.airSampleDeltaVoc)) ? Number(latest.airSampleDeltaVoc) : null,
        result: latest.airSampleResult || "",
        completedAt: Number(latest.airSampleCompletedAt) || null,
      } : null,
      ...metrics,
      pollen,
      googleAir,
      smell,
      cause,
      outlook,
      ventilation,
      airSense,
      series: trend,
    };
}

async function homeStats(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // s-maxage matches the dashboard's 120 s poll so alternate polls hit the
  // edge instead of rebuilding the ~2 MB home payload.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=120, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const payload = await buildHomePayload(req.query?.triggers, req.query?.severity);
    if (!payload) return res.status(204).end();
    return res.status(200).json(payload);
  } catch (err) {
    console.error("home-stats error:", err);
    return res.status(500).json({ error: "home-stats error" });
  }
}

// ── oled ─────────────────────────────────────────────────────────────────
// GET /api/oled — tiny pre-formatted status for the wall-mounted OLED:
// smell state, likely cause + action, allergen level, outdoor pollen/AQI.
// Device-sized (under ~700 bytes). Read-only like the other dashboard GETs.
//
// The wall feed polls every 60 s for the same fixed trigger set, so the
// formatted view itself is cached 300 s: the wall feed then never triggers
// a full ~2 MB home-payload rebuild.
const OLED_VIEW_TTL_SEC = 300;

async function oled(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  // s-maxage matches the device's 60 s wall poll so alternate polls hit the edge.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    try {
      const cached = await getJsonCache("oled-view");
      if (cached) return res.status(200).json(cached);
    } catch {}
    // A wall display near the cats cares about every household trigger.
    const payload = await buildHomePayload("cat,dog,pollen,dustMite,mold,smoke");
    if (!payload) return res.status(204).end();
    const view = toOledView(payload);
    try {
      await setJsonCache("oled-view", view, OLED_VIEW_TTL_SEC);
    } catch {}
    return res.status(200).json(view);
  } catch (err) {
    console.error("oled error:", err);
    return res.status(500).json({ error: "oled error" });
  }
}

// ── guest ────────────────────────────────────────────────────────────────
// GET /api/guest — public, read-only view for visitors. Same analysis as the
// Home tab but trimmed to what a guest needs: no location, city, coordinates,
// device details or occupancy. Also returns the push-alert topic to follow.
async function guest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    const payload = await buildHomePayload(req.query?.triggers);
    if (!payload) return res.status(204).end();
    return res.status(200).json(toGuestView(payload, { topic: guestTopic() }));
  } catch (err) {
    console.error("guest error:", err);
    return res.status(500).json({ error: "guest error" });
  }
}

// ── sniff-stream ─────────────────────────────────────────────────────────
// GET /api/sniff-stream — lightweight SSE stream for the latest sulfur/VSC
// priority event. Polls the store for up to 25 seconds, then the browser reconnects.
const STREAM_WINDOW_MS = 25000;
const POLL_MS = 10000; // was 1500ms (~57K store reads/day per open tab); only /classic uses this stream now
const HEARTBEAT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function sniffStream(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2500\n\n");
  res.flushHeaders?.();
  res.socket?.setTimeout(0);

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  let lastSeq = Number(req.query.after || 0);
  let lastHeartbeat = 0;
  const startedAt = Date.now();

  try {
    const initial = await getLatestSniff();
    const initialSeq = Number(initial?.seq || 0);
    if (initial && initialSeq > lastSeq) {
      lastSeq = initialSeq;
      sendEvent(res, "sniff", initial);
    }

    while (!closed && Date.now() - startedAt < STREAM_WINDOW_MS) {
      await sleep(POLL_MS);
      if (closed) break;

      const latest = await getLatestSniff();
      const latestSeq = Number(latest?.seq || 0);
      if (latest && latestSeq > lastSeq) {
        lastSeq = latestSeq;
        sendEvent(res, "sniff", latest);
        lastHeartbeat = Date.now();
        continue;
      }

      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
        lastHeartbeat = Date.now();
      }
    }
  } catch (err) {
    console.error("sniff-stream error:", err);
    sendEvent(res, "error", { error: "stream error" });
  }

  res.end();
}

// ── weather-briefing ─────────────────────────────────────────────────────
// GET /api/weather-briefing — local forecast bundle + a concise weather
// insight. Uses Open-Meteo for forecast data and, when OPENAI_API_KEY is
// configured, an OpenAI-generated local briefing. Always uses the manually
// configured Cape Canaveral coordinates — does not rely on device
// WiFi-derived geolocation for weather API calls.
const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_AQ_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";
const DEFAULT_LAT = 28.4889;
const DEFAULT_LON = -80.5778;
const DEFAULT_CITY = "Cape Canaveral, FL";

function getEffectiveLocation(snapshot) {
  // Use the device's GPS coordinates when they are a genuine fix (not 0,0).
  // Fall back to the hardcoded Cape Canaveral position when no GPS fix is available.
  const lat = Number(snapshot?.lat);
  const lon = Number(snapshot?.lon);
  const city = snapshot?.city;
  if (Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001)) {
    return {
      lat,
      lon,
      city: city || "Device location",
      usingDefault: false,
    };
  }
  return {
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
    city: DEFAULT_CITY,
    usingDefault: true,
  };
}

function weatherCodeLabel(code) {
  const value = Math.round(num(code, -1));
  if (value === 0) return "Clear";
  if ([1, 2].includes(value)) return "Partly cloudy";
  if (value === 3) return "Overcast";
  if ([45, 48].includes(value)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(value)) return "Drizzle";
  if ([61, 63, 65, 66, 67].includes(value)) return "Rain";
  if ([71, 73, 75, 77].includes(value)) return "Snow";
  if ([80, 81, 82].includes(value)) return "Showers";
  if ([85, 86].includes(value)) return "Snow showers";
  if ([95, 96, 99].includes(value)) return "Thunderstorms";
  return "Weather active";
}

function dayLabel(isoDate) {
  if (!isoDate) return "Forecast";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function windDirLabel(deg) {
  const d = num(deg, NaN);
  if (!Number.isFinite(d)) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(d / 45) % 8] || "";
}

function aqiLevel(aqi) {
  const v = num(aqi, NaN);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v <= 50) return "Good";
  if (v <= 100) return "Moderate";
  if (v <= 150) return "Sensitive Groups";
  if (v <= 200) return "Unhealthy";
  if (v <= 300) return "Very Unhealthy";
  return "Hazardous";
}

function conditionSummary(forecast) {
  if (!forecast.length) return "Forecast guidance pending";
  const warmest = [...forecast].sort((a, b) => num(b.highF) - num(a.highF))[0];
  const wettest = [...forecast].sort((a, b) => num(b.precipChance) - num(a.precipChance))[0];
  const breeziest = [...forecast].sort((a, b) => num(b.windMph) - num(a.windMph))[0];
  return `${warmest?.label || "The next few days"} top out around ${Math.round(num(warmest?.highF, 0))}F, with the wettest window on ${wettest?.label || "the current forecast"} and peak winds near ${Math.round(num(breeziest?.windMph, 0))} mph.`;
}

function ventilationWindow(snapshot, forecast) {
  if (!forecast.length) return "Ventilation window is being estimated from current outdoor conditions only.";
  const best = [...forecast].sort((a, b) => {
    const aScore = num(a.precipChance) * 0.7 + Math.max(0, num(a.highF) - 82) + Math.max(0, num(a.windMph) - 16);
    const bScore = num(b.precipChance) * 0.7 + Math.max(0, num(b.highF) - 82) + Math.max(0, num(b.windMph) - 16);
    return aScore - bScore;
  })[0];
  if (!best) return "Ventilation window is being estimated from current outdoor conditions only.";
  return `${best.label} currently looks like the easiest ventilation window, with ${Math.round(num(best.precipChance, 0))}% rain risk and winds near ${Math.round(num(best.windMph, 0))} mph.`;
}

function weatherFallbackBriefing(snapshot, forecast, outdoorAqi) {
  const city = snapshot?.city || DEFAULT_CITY;
  const current = snapshot?.weatherCondition || "conditions in flux";
  const outdoor = num(outdoorAqi, NaN);
  const outdoorLine = Number.isFinite(outdoor) && outdoor > 0
    ? `Outdoor AQI is ${Math.round(outdoor)} (${aqiLevel(outdoor)}).`
    : "Outdoor AQI is still syncing.";
  return `${city} is trending ${current.toLowerCase()} right now. ${conditionSummary(forecast)} ${ventilationWindow(snapshot, forecast)} ${outdoorLine}`.trim();
}

function weatherSourceCaption(mode, hasForecast, usingDefault) {
  const parts = usingDefault ? ["Cape Canaveral default location"] : ["device weather snapshot"];
  if (hasForecast) parts.push("Open-Meteo forecast", "Open-Meteo air quality");
  parts.push("OpenStreetMap map", "RainViewer radar");
  parts.push(mode === "openai" ? "OpenAI local forecast brief" : "deterministic local forecast logic");
  return `Source: ${parts.join(" · ")}`;
}

async function fetchForecastAndCurrent(loc) {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    timezone: "auto",
    forecast_days: "3",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
  });

  const res = await fetch(`${OPEN_METEO_BASE}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const json = await res.json();

  const daily = json?.daily;
  const forecast = daily?.time?.length
    ? daily.time.map((date, index) => ({
        date,
        label: dayLabel(date),
        condition: weatherCodeLabel(daily.weather_code?.[index]),
        highF: num(daily.temperature_2m_max?.[index], NaN),
        lowF: num(daily.temperature_2m_min?.[index], NaN),
        precipChance: num(daily.precipitation_probability_max?.[index], 0),
        windMph: num(daily.wind_speed_10m_max?.[index], 0),
      })).slice(0, 3)
    : [];

  const cur = json?.current;
  const current = cur ? {
    condition: weatherCodeLabel(cur.weather_code),
    tempF: num(cur.temperature_2m, NaN),
    feelsLikeF: num(cur.apparent_temperature, NaN),
    humidity: num(cur.relative_humidity_2m, NaN),
    windSpeed: num(cur.wind_speed_10m, NaN) > 0 ? `${Math.round(num(cur.wind_speed_10m))} mph` : "",
    windDir: windDirLabel(cur.wind_direction_10m),
    pressHpa: num(cur.pressure_msl, NaN),
    isDay: Boolean(cur.is_day),
  } : null;

  return { forecast, current };
}

async function fetchAirQuality(loc) {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    current: "us_aqi",
  });

  const res = await fetch(`${OPEN_METEO_AQ_BASE}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`open-meteo-aq ${res.status}`);
  const json = await res.json();
  const aqi = num(json?.current?.us_aqi, NaN);
  if (!Number.isFinite(aqi) || aqi < 0) return null;
  return { aqi: Math.round(aqi), level: aqiLevel(aqi) };
}

async function generateOpenAiBrief(snapshot, loc, forecast, outdoorAqi, fallback) {
  const apiKey = `${process.env.OPENAI_API_KEY || ""}`.trim();
  if (!apiKey || !forecast.length) return null;

  const model = `${process.env.OPENAI_WEATHER_MODEL || "gpt-5.4-nano"}`.trim();
  const prompt = [
    "Write a concise local weather forecast insight for a professional sensor dashboard.",
    "Keep it to 2 or 3 sentences, under 90 words.",
    "Focus on local comfort, ventilation timing, rain risk, and anything notable over the next 3 days.",
    "Do not mention AI, models, or probabilities unless they are useful. Do not be chatty.",
    `Location: ${loc.city || snapshot.city || "Local area"}.`,
    `Current outdoor context: ${snapshot.weatherCondition || "Conditions syncing"}, ${Number.isFinite(num(snapshot.tempF, NaN)) ? `${Math.round(num(snapshot.tempF))}F` : "temp unknown"}, humidity ${Number.isFinite(num(snapshot.humidity, NaN)) ? `${Math.round(num(snapshot.humidity))}%` : "unknown"}, AQI ${Number.isFinite(num(outdoorAqi, NaN)) ? Math.round(num(outdoorAqi)) : "unknown"}.`,
    `Forecast: ${forecast.map((day) => `${day.label}: ${day.condition}, high ${Math.round(num(day.highF, 0))}F, low ${Math.round(num(day.lowF, 0))}F, precip ${Math.round(num(day.precipChance, 0))}%, wind ${Math.round(num(day.windMph, 0))} mph`).join(" | ")}`,
    `If the forecast is unremarkable, say so cleanly. Baseline fallback: ${fallback}`,
  ].join("\n");

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 150,
    }),
  });

  if (!res.ok) {
    throw new Error(`openai ${res.status}`);
  }

  const json = await res.json();
  const text = extractOutputText(json);
  return text || null;
}

async function weatherBriefing(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  try {
    const snapshot = await getLatest();
    if (!snapshot) return res.status(204).end();

    const loc = getEffectiveLocation(snapshot);

    let forecast = [];
    let currentConditions = null;
    try {
      const result = await fetchForecastAndCurrent(loc);
      forecast = result.forecast;
      currentConditions = result.current;
    } catch (err) {
      console.error("weather-briefing forecast error:", err);
    }

    let outdoorAqi = num(snapshot.outdoorAqi, NaN);
    let outdoorLevel = snapshot.outdoorLevel || "";
    try {
      const aq = await fetchAirQuality(loc);
      if (aq) {
        outdoorAqi = aq.aqi;
        outdoorLevel = aq.level;
      }
    } catch (err) {
      console.error("weather-briefing AQ error:", err);
    }

    const fallback = weatherFallbackBriefing(snapshot, forecast, outdoorAqi);
    let briefing = fallback;
    let mode = "deterministic";

    try {
      const aiBrief = await generateOpenAiBrief(snapshot, loc, forecast, outdoorAqi, fallback);
      if (aiBrief) {
        briefing = aiBrief;
        mode = "openai";
      }
    } catch (err) {
      console.error("weather-briefing openai error:", err);
    }

    return res.status(200).json({
      city: loc.city || snapshot.city || "",
      lat: loc.lat,
      lon: loc.lon,
      usingDefault: loc.usingDefault,
      briefing,
      mode,
      summary: conditionSummary(forecast),
      forecast,
      current: currentConditions,
      outdoorAqi: Number.isFinite(outdoorAqi) && outdoorAqi > 0 ? outdoorAqi : null,
      outdoorLevel: outdoorLevel || null,
      receivedAt: snapshot.receivedAt || null,
      generatedAt: Date.now(),
      sourceCaption: weatherSourceCaption(mode, forecast.length > 0, loc.usingDefault),
    });
  } catch (err) {
    console.error("weather-briefing error:", err);
    return res.status(500).json({ error: "weather briefing error" });
  }
}

// ── settings ─────────────────────────────────────────────────────────────
// GET  /api/settings — public read of effective alert thresholds (so the
//                      dashboard can show/sync the live alarm limits).
// POST /api/settings — public, unauthenticated update of the adjustable
//                      limits (humidityHigh, tempHighC, co2High, iaqPoor,
//                      gasDropPct, alertCooldownMin, environmentType).
//                      Deliberately no owner key: this is a personal
//                      single-tenant dashboard, and the tradeoff is that
//                      anyone with the dashboard URL can retune alarms.
//                      Every field is clamped to a safe range in
//                      getEffectiveThresholds/getEffectiveAlertCooldownMs so
//                      a bad (or malicious) input can never fully silence
//                      monitoring — see THRESHOLD_LIMITS/ALERT_COOLDOWN_LIMITS.
function effectiveSettingsPayload(overrides) {
  const t = getEffectiveThresholds(overrides);
  const gasDropPct = Math.round((1 - t.GAS_DROP_RATIO) * 100);
  return {
    humidityHigh: t.HUMIDITY_HIGH,
    tempHighC: t.TEMP_HIGH_C,
    co2High: t.CO2_HIGH,
    iaqPoor: t.IAQ_POOR,
    pm25High: t.PM25_HIGH,
    gasDropPct,
    alertCooldownMin: Math.round(getEffectiveAlertCooldownMs(overrides) / 60000),
    environmentType: normalizeEnvironmentType(overrides?.environmentType),
    updatedAt: Number(overrides?.updatedAt) || null,
    defaults: {
      humidityHigh: THRESHOLDS.HUMIDITY_HIGH,
      tempHighC: THRESHOLDS.TEMP_HIGH_C,
      co2High: THRESHOLDS.CO2_HIGH,
      iaqPoor: THRESHOLDS.IAQ_POOR,
      pm25High: THRESHOLDS.PM25_HIGH,
      gasDropPct: Math.round((1 - THRESHOLDS.GAS_DROP_RATIO) * 100),
      alertCooldownMin: DEFAULT_ALERT_COOLDOWN_MIN,
      environmentType: DEFAULT_ENVIRONMENT_TYPE,
    },
    environmentTypes: ENVIRONMENT_TYPES,
    limits: { ...THRESHOLD_LIMITS, ALERT_COOLDOWN_MIN: ALERT_COOLDOWN_LIMITS },
  };
}

async function settings(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    try {
      const stored = await getSettings();
      return res.status(200).json(effectiveSettingsPayload(stored));
    } catch (err) {
      console.error("settings read error:", err);
      // Never break the dashboard over a settings read — serve defaults.
      return res.status(200).json(effectiveSettingsPayload({}));
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "GET/POST only" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const patch = {};
  if (body.humidityHigh !== undefined) {
    const v = Number(body.humidityHigh);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "humidityHigh must be a number" });
    patch.humidityHigh = v;
  }
  if (body.tempHighC !== undefined) {
    const v = Number(body.tempHighC);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "tempHighC must be a number" });
    patch.tempHighC = v;
  }
  if (body.co2High !== undefined) {
    const v = Number(body.co2High);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "co2High must be a number" });
    patch.co2High = v;
  }
  if (body.iaqPoor !== undefined) {
    const v = Number(body.iaqPoor);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "iaqPoor must be a number" });
    patch.iaqPoor = v;
  }
  if (body.pm25High !== undefined) {
    const v = Number(body.pm25High);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "pm25High must be a number" });
    patch.pm25High = v;
  }
  if (body.gasDropPct !== undefined) {
    const v = Number(body.gasDropPct);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "gasDropPct must be a number" });
    patch.gasDropPct = v;
  }
  if (body.alertCooldownMin !== undefined) {
    const v = Number(body.alertCooldownMin);
    if (!Number.isFinite(v)) return res.status(400).json({ error: "alertCooldownMin must be a number" });
    patch.alertCooldownMin = v;
  }
  if (body.environmentType !== undefined) {
    // Accept current types plus legacy aliases (e.g. "construction" →
    // "industrial") so older clients keep working; store the normalized name.
    if (!isKnownEnvironmentType(body.environmentType)) {
      return res.status(400).json({ error: `environmentType must be one of: ${ENVIRONMENT_TYPES.join(", ")}` });
    }
    patch.environmentType = normalizeEnvironmentType(body.environmentType);
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({
      error: "no adjustable settings supplied (humidityHigh, tempHighC, co2High, iaqPoor, pm25High, gasDropPct, alertCooldownMin, environmentType)",
    });
  }

  try {
    const stored = await putSettings(patch);
    return res.status(200).json({ ok: true, ...effectiveSettingsPayload(stored) });
  } catch (err) {
    console.error("settings write error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}

/**
 * GET /api/report-card — the latest summary rendered as an image, so a
 * report/alert and its push notification carry a visual, not just text.
 * Picks whichever is newer between the morning report and the last
 * real-time alert's own snapshot, so an alert's MMS shows the alert's own
 * numbers rather than a stale morning report from hours earlier.
 * ?format=png renders a raster PNG (for MMS media_file, which carriers
 * expect over SVG); default is SVG for ntfy Attach / dashboard <img> use.
 * Public and read-only (no secrets in the image); cached briefly.
 */
async function reportCard(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const [daily, alert] = await Promise.all([getDailySummary(), getAlertSnapshot()]);
    const summary = num(alert?.generatedAt) > num(daily?.generatedAt) ? alert : daily;
    if (req.query?.format === "json") {
      // Powers web/public/report.html — the "visually nice report" the SMS/MMS
      // link points to, so message bodies can stay a short summary instead of
      // a raw stats dump.
      res.setHeader("Cache-Control", "no-store");
      if (!summary) return res.status(204).end();
      return res.status(200).json(summary);
    }
    if (req.query?.format === "png") {
      const png = renderReportCardPng(summary || {});
      res.setHeader("Content-Type", "image/png");
      return res.status(200).end(png);
    }
    const svg = buildReportCardSvg(summary || {});
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.status(200).end(svg);
  } catch (err) {
    console.error("report-card error:", err);
    return res.status(500).json({ error: "report-card error" });
  }
}

// ── insights ─────────────────────────────────────────────────────────────
// GET /api/insights — friendly briefing for the dashboard's front page.
// Claude writes it when ANTHROPIC_API_KEY is set (see lib/insights.js); the
// result is cached per bucketed room state so a busy page costs one call per
// ~20 minutes of meaningful change, not one per visitor.
const INSIGHTS_TTL_SEC = 20 * 60;

async function insights(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    const home = await buildHomePayload("");
    if (!home) return res.status(204).end();
    const latest = await getLatest();
    let weather = null;
    try {
      const hit = await getJsonCache("insights-weather");
      weather = hit || (await fetchForecastAndCurrent(getEffectiveLocation(latest)));
      if (!hit && weather) await setJsonCache("insights-weather", weather, 30 * 60);
    } catch (err) {
      console.error("insights: forecast failed:", err?.message || err);
    }
    const facts = insightFacts(home, latest, weather);
    const key = `insights:${createHash("sha256").update(insightCacheKey(facts)).digest("hex").slice(0, 20)}`;
    let out = await getJsonCache(key);
    if (!out) {
      out = (await claudeInsights(facts)) || fallbackInsights(facts);
      out.generatedAt = Date.now();
      await setJsonCache(key, out, out.source === "claude" ? INSIGHTS_TTL_SEC : 120);
    }
    return res.status(200).json({ ...out, receivedAt: home.receivedAt, aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
  } catch (err) {
    console.error("insights error:", err);
    return res.status(500).json({ error: "insights error" });
  }
}

// ── ai-insight ───────────────────────────────────────────────────────────
// GET /api/ai-insight — one short, human, tailored insight about what the
// current air means for focus and breathing. OpenAI writes it when
// OPENAI_API_KEY is set (see lib/aiInsight.js); otherwise a deterministic
// writer says the same kind of thing from the same facts, and the response
// always says which mode produced it. The text is cached per bucketed room
// state and regenerated only on material change — a breach, a big swing, or
// a move to steady air — with a 15-minute floor between OpenAI calls (a
// breach appearing or clearing may regenerate sooner, never faster than
// 2 minutes), so a poll cycle can't spam the API. Never returns the key.
async function aiInsight(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // s-maxage matches the dashboard's 120 s home poll; the insight text
  // itself is already cached per bucketed room state server-side.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=120, stale-while-revalidate=60");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    const [home, latest, settings, alertState] = await Promise.all([
      buildHomePayload(req.query?.triggers, req.query?.severity),
      getLatest(),
      getSettings(),
      getAlertState().catch(() => null),
    ]);
    if (!home) return res.status(204).end();
    const facts = aiInsightFacts(home, latest, settings, req.query?.triggers, req.query?.severity, {
      gasBase: alertState?.gasBase,
    });
    const stateKey = aiInsightCacheKey(facts);
    const hash = createHash("sha256").update(stateKey).digest("hex").slice(0, 20);
    const perStateKey = `ai-insight:${hash}`;
    const perState = await getJsonCache(perStateKey).catch(() => null);
    const last = await getJsonCache("ai-insight:last").catch(() => null);
    const decision = resolveInsightCache({
      perState,
      last,
      breaches: facts.breaches.map((b) => b.key),
    });
    const aiConfigured = Boolean(process.env.OPENAI_API_KEY);
    if (decision === "per-state" && perState) {
      return res.status(200).json({ ...perState, receivedAt: home.receivedAt, aiConfigured });
    }
    if (decision === "last" && last) {
      return res.status(200).json({ ...last, receivedAt: home.receivedAt, aiConfigured });
    }
    const aiText = await generateAiInsight(facts);
    const mode = aiText ? "openai" : "deterministic";
    const entry = {
      text: aiText || fallbackInsight(facts),
      mode,
      generatedAt: Date.now(),
      breaches: facts.breaches.map((b) => b.key),
    };
    await setJsonCache(perStateKey, entry, mode === "openai" ? AI_INSIGHT_TTL_SEC : AI_INSIGHT_FALLBACK_TTL_SEC).catch(() => {});
    if (mode === "openai") await setJsonCache("ai-insight:last", entry, AI_INSIGHT_TTL_SEC).catch(() => {});
    return res.status(200).json({ ...entry, receivedAt: home.receivedAt, aiConfigured });
  } catch (err) {
    console.error("ai-insight error:", err?.message || err);
    return res.status(500).json({ error: "ai-insight error" });
  }
}

// ── sensors ──────────────────────────────────────────────────────────────
// GET /api/sensors?range=1h|6h|24h|7d — every BME688 / BSEC channel as
// downsampled column arrays for the detail charts, plus the latest snapshot.
// 1h–6h read the full 1-minute snapshot buffer; 24h reads the compact
// 1-minute climate series (temperature, humidity, CO2, IAQ only — same shape
// as 7d, which reads the compact 10-minute series). Odor classifier scores
// are only available from the full buffer, so 24h/7d return odors: null.
const SENSOR_FIELDS = ["iaq", "staticIaq", "voc", "dVoc", "co2", "tempF", "humidity", "pressHpa", "gasR", "compGas", "gasPct", "airScore", "iaqAcc", "pm25", "pm10"];
const RANGE_MIN = { "1h": 60, "6h": 360, "24h": 1440 };

function bucketMean(rows, maxPoints, pickers) {
  const step = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out = { t: [] };
  for (const k of Object.keys(pickers)) out[k] = [];
  for (let i = 0; i < rows.length; i += step) {
    const chunk = rows.slice(i, i + step);
    out.t.push(Math.round(chunk.reduce((a, r) => a + Number(r.receivedAt ?? r.t), 0) / chunk.length));
    for (const [k, pick] of Object.entries(pickers)) {
      const vals = chunk.map(pick).filter((v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))).map(Number);
      out[k].push(vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100 : null);
    }
  }
  return out;
}

async function sensors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const range = ["1h", "6h", "24h", "7d"].includes(req.query?.range) ? req.query.range : "6h";
  try {
    const latest = await getLatest();
    if (!latest) return res.status(204).end();
    let series;
    let odors = null;
    if (range === "7d") {
      const { coarse } = await getHomeSeries();
      const rows = [...coarse].sort((a, b) => a.t - b.t);
      series = bucketMean(rows, 336, {
        tempF: (r) => (Number.isFinite(Number(r.tc)) ? (r.tc * 9) / 5 + 32 : null),
        humidity: (r) => r.rh,
        co2: (r) => r.co2,
        iaq: (r) => r.iaq,
        pm25: (r) => r.pm25,
      });
    } else if (range === "24h") {
      // Same compact shape as 7d, from the 1-minute fine series instead of
      // the 10-minute coarse one — no 1,470-row full-history pull + bucket.
      const { fine } = await getHomeSeries();
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const rows = [...fine].filter((p) => Number(p.t) >= cutoff).sort((a, b) => a.t - b.t);
      series = bucketMean(rows, 240, {
        tempF: (r) => (Number.isFinite(Number(r.tc)) ? (r.tc * 9) / 5 + 32 : null),
        humidity: (r) => r.rh,
        co2: (r) => r.co2,
        iaq: (r) => r.iaq,
        pm25: (r) => r.pm25,
      });
    } else {
      const cutoff = Date.now() - RANGE_MIN[range] * 60 * 1000;
      const rows = (await getHistory(RANGE_MIN[range] + 30)).filter((r) => Number(r.receivedAt) >= cutoff).reverse();
      const pickers = Object.fromEntries(SENSOR_FIELDS.map((k) => [k, (r) => r[k]]));
      series = bucketMean(rows, 240, pickers);
      // Odor classifier scores, same buckets, for the smell heatmap.
      const step = Math.max(1, Math.ceil(rows.length / 240));
      odors = [];
      for (let i = 0; i < rows.length; i += step) {
        const chunk = rows.slice(i, i + step).filter((r) => Array.isArray(r.odors));
        odors.push(chunk.length ? Array.from({ length: 20 }, (_, j) => Math.round(Math.max(...chunk.map((r) => Number(r.odors[j]) || 0)))) : null);
      }
    }
    return res.status(200).json({ range, latest, series, odors });
  } catch (err) {
    console.error("sensors error:", err);
    return res.status(500).json({ error: "sensors error" });
  }
}

// ── alerts ───────────────────────────────────────────────────────────────
// GET  /api/alerts               → which channels work + the rule catalogue
// GET  /api/alerts?unsub=<token> → one-tap unsubscribe (HTML page)
// GET  /api/alerts?token=<token> → that subscriber's rules + masked address
// POST /api/alerts {action:"subscribe", channel, address, rules}
// POST /api/alerts {action:"verify", id, code}
// POST /api/alerts {action:"update", token, rules}
async function alerts(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.query?.unsub) {
    let ok = false;
    try {
      ok = await unsubscribe(req.query.unsub);
    } catch (err) {
      console.error("alerts unsubscribe:", err);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SniffMaster alerts</title>
<body style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<div style="max-width:420px;text-align:center"><h1 style="font-size:22px">${ok ? "You're unsubscribed" : "Already unsubscribed"}</h1>
<p style="color:#9aa7b8">${ok ? "You won't get any more SniffMaster alerts." : "That link has already been used or has expired."}</p>
<p><a href="/#/alerts" style="color:#7cc4ff">Back to the dashboard</a></p></div></body>`);
  }
  if (req.method === "GET" && req.query?.token) {
    const sub = await getSubscriberByToken(req.query.token).catch(() => null);
    if (!sub) return res.status(404).json({ error: "That link isn't recognized. Use the unsubscribe link in an alert email." });
    return res.status(200).json(publicSubscriber(sub));
  }
  if (req.method === "GET") {
    const subs = await loadSubscribers().catch(() => []);
    const availability = await alertChannels().catch(() => ({ channels: { email: false, sms: false, push: true }, smsReason: null }));
    return res.status(200).json({
      channels: availability.channels,
      smsReason: availability.smsReason,
      subscriberCount: subs.filter((s) => s.verified).length,
      rules: Object.fromEntries(Object.entries(SUBSCRIBER_RULES).map(([k, r]) => [k, { label: r.label, hint: r.hint || "", unit: r.unit, dir: r.dir, def: r.def, min: r.min, max: r.max, easy: r.easy || 0 }])),
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  try {
    if (body.action === "subscribe") {
      return res.status(200).json(await startSubscription({ channel: body.channel, address: body.address, rules: body.rules, ip }));
    }
    if (body.action === "verify") {
      return res.status(200).json(await confirmSubscription({ id: body.id, code: body.code }));
    }
    if (body.action === "update") {
      return res.status(200).json(await updateSubscriberRules({ token: body.token, rules: body.rules }));
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    if (err instanceof AlertError) return res.status(err.status).json({ error: err.message });
    console.error("alerts error:", err);
    return res.status(500).json({ error: "Something went wrong. Try again in a minute." });
  }
}

// ── environment ──────────────────────────────────────────────────────────
// GET/POST /api/environment — compact Google (or Open-Meteo) outdoor context.
// Device auth only. The Google key stays on the server.
async function environment(req, res) {
  setCommandHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET/POST only" });
  }
  if (!requireDeviceAuth(req, res)) return;

  const body = req.method === "POST" && req.body && typeof req.body === "object" ? req.body : {};
  const lat = Number(body.lat ?? req.query?.lat);
  const lon = Number(body.lon ?? req.query?.lon);
  const wifi = Array.isArray(body.wifi) ? body.wifi.slice(0, 8) : [];
  const storeReady = isStoreConfigured();
  try {
    const result = await lookupEnvironment(
      { lat, lon, wifi },
      {
        cacheGet: storeReady ? (key) => getJsonCache(key) : null,
        cacheSet: storeReady ? (key, value, ttl) => setJsonCache(key, value, ttl) : null,
        incr: storeReady ? (key, ttl) => incrCounter(key, ttl) : null,
      }
    );
    return res.status(200).json(result && typeof result === "object" ? result : { ok: false });
  } catch {
    // Do not log the error: a fetch failure can include the request URL, and that URL holds the API key.
    console.error("environment lookup failed");
    return res.status(200).json({ ok: false });
  }
}

// ── dispatcher ───────────────────────────────────────────────────────────
const ROUTES = {
  apod,
  command,
  environment,
  launches,
  "occupancy-briefing": occupancyBriefing,
  "office-stats": officeStats,
  "home-stats": homeStats,
  guest,
  oled,
  "sniff-stream": sniffStream,
  "weather-briefing": weatherBriefing,
  settings,
  "report-card": reportCard,
  insights,
  "ai-insight": aiInsight,
  sensors,
  alerts,
  "air-tile": airTile,
};

export default async function handler(req, res) {
  const fn = String(req.query?.fn || "");
  const route = ROUTES[fn];
  if (!route) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ error: `unknown extras route: ${fn || "(none)"}` });
  }
  return route(req, res);
}
