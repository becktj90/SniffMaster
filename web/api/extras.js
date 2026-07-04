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

import { requireDeviceAuth, requireOwnerAuth } from "../lib/auth.js";
import {
  isRedisConfigured,
  getLatest,
  getLatestBleOccupancy,
  getBleOccupancyHistory,
  getHistory,
  getLatestCommand,
  putCommand,
  getLatestSniff,
  getSettings,
  putSettings,
} from "../lib/store.js";
import { getEffectiveThresholds, THRESHOLDS, THRESHOLD_LIMITS } from "../lib/thresholds.js";
import { getCapeLaunches, getCached as getCachedLaunches, setCache as setCacheLaunches, fetchLaunches } from "../lib/launches.js";
import { Redis } from "@upstash/redis";

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
// GET /api/apod — NASA Astronomy Picture of the Day, cached 24h in Redis,
// falling back to the NASA Image and Video Library (no key required).
const APOD_BASE = "https://api.nasa.gov/planetary/apod";
const APOD_CACHE_KEY = "sniffmaster:apod";
const APOD_CACHE_TTL_SEC = 86400; // 24 hours — picture changes once a day
const NASA_IMAGES_BASE = "https://images-api.nasa.gov/search";
const NASA_IMAGES_QUERIES = ["nebula", "galaxy", "aurora", "solar system", "deep space", "supernova", "milky way", "earth from space"];
const APOD_FALLBACK_CACHE_KEY = "sniffmaster:apod-fallback";

async function getApodCached(key = APOD_CACHE_KEY) {
  if (!isRedisConfigured()) return null;
  try {
    const redis = Redis.fromEnv();
    const raw = await redis.get(key);
    if (!raw) return null;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    // Invalidate if the stored date doesn't match today (UTC)
    const today = new Date().toISOString().slice(0, 10);
    if (data?.date && data.date !== today) return null;
    return data;
  } catch {
    return null;
  }
}

async function setApodCache(data, key = APOD_CACHE_KEY) {
  if (!isRedisConfigured()) return;
  try {
    const redis = Redis.fromEnv();
    await redis.set(key, JSON.stringify(data), { ex: APOD_CACHE_TTL_SEC });
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
const COMMAND_TTL_MS = 10 * 60 * 1000;
const ALLOWED_ACTIONS = new Set(["refresh", "breath_check", "presence_probe"]);

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
      const latest = await getLatestCommand();
      if (!latest) return res.status(204).end();
      if (Number.isFinite(after) && Number(latest.seq || 0) <= after) {
        return res.status(204).end();
      }
      if (Date.now() - Number(latest.receivedAt || 0) > COMMAND_TTL_MS) {
        return res.status(204).end();
      }
      return res.status(200).json(latest);
    } catch (err) {
      console.error("getLatestCommand error:", err);
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
// GET /api/launches — Cape Canaveral launches, 1h Redis cache (lib/launches.js)
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

function densityNote(index, source) {
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

function occupancyFallbackBriefing(index, deviceCount, trend, snapshot, source) {
  const label = densityLabel(index);
  const trendStr = trend.direction === "rising"
    ? "and occupancy is climbing"
    : trend.direction === "falling"
      ? "and occupancy is declining"
      : "with stable occupancy";
  const co2 = num(snapshot?.co2);
  if (source === "co2" && co2 > 0) {
    return `${label} occupancy (index ${index}) estimated from CO₂ at ${Math.round(co2)} ppm ${trendStr}. CO₂ is a reliable proxy for room occupancy — elevated readings indicate more people or reduced ventilation.`;
  }
  const co2Line = co2 > 900
    ? ` CO2 is elevated at ${Math.round(co2)} ppm — consistent with the detected occupancy load.`
    : co2 > 0
      ? ` CO2 is at ${Math.round(co2)} ppm, which aligns with current occupancy.`
      : "";
  return `${label} occupancy (index ${index}) with ${deviceCount} BLE device${deviceCount !== 1 ? "s" : ""} detected ${trendStr}.${co2Line}`;
}

async function generateOpenAiBriefing(occupancyData, snapshot, trend, fallback, source) {
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
    ? `Occupancy is estimated from CO₂ (${Math.round(co2)} ppm). CO₂ above ~400 ppm ambient indicates people are present.`
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

    const trend   = deriveTrend(history.length >= 2 ? history : []);
    const fallback = occupancyFallbackBriefing(index, devices, trend, snapshot, source);

    let briefing = fallback;
    let mode = "deterministic";

    try {
      const occupancyData = { occupancyIndex: index, deviceCount: devices, avgRssi };
      const aiBriefing = await generateOpenAiBriefing(occupancyData, snapshot, trend, fallback, source);
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
      densityNote:     densityNote(index, source),
      source,
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

// ── sniff-stream ─────────────────────────────────────────────────────────
// GET /api/sniff-stream — lightweight SSE stream for the latest sulfur/VSC
// priority event. Polls Redis for up to 25 seconds, then the browser reconnects.
const STREAM_WINDOW_MS = 25000;
const POLL_MS = 1500;
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
//                      dashboard can show/sync the live humidity alarm limit).
// POST /api/settings — owner-authenticated update of the adjustable limits
//                      (currently humidityHigh, tempHighC). Values are clamped
//                      to safe ranges in getEffectiveThresholds so a bad input
//                      can never silently disable monitoring.
function effectiveSettingsPayload(overrides) {
  const t = getEffectiveThresholds(overrides);
  return {
    humidityHigh: t.HUMIDITY_HIGH,
    tempHighC: t.TEMP_HIGH_C,
    updatedAt: Number(overrides?.updatedAt) || null,
    defaults: { humidityHigh: THRESHOLDS.HUMIDITY_HIGH, tempHighC: THRESHOLDS.TEMP_HIGH_C },
    limits: THRESHOLD_LIMITS,
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

  if (!requireOwnerAuth(req, res)) return;

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
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "no adjustable settings supplied (humidityHigh, tempHighC)" });
  }

  try {
    const stored = await putSettings(patch);
    return res.status(200).json({ ok: true, ...effectiveSettingsPayload(stored) });
  } catch (err) {
    console.error("settings write error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}

// ── dispatcher ───────────────────────────────────────────────────────────
const ROUTES = {
  apod,
  command,
  launches,
  "occupancy-briefing": occupancyBriefing,
  "office-stats": officeStats,
  "sniff-stream": sniffStream,
  "weather-briefing": weatherBriefing,
  settings,
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
