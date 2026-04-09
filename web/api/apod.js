/**
 * GET /api/apod — returns NASA Astronomy Picture of the Day
 *
 * Fetches from the NASA APOD API and caches the result in Upstash Redis
 * for 24 hours (the picture changes once per day).
 * Falls back to the NASA Image and Video Library (no API key required) when
 * APOD is unavailable due to rate limiting or other errors.
 *
 * Data source: https://apod.nasa.gov/apod/ (NASA public API)
 * API docs: https://api.nasa.gov/#apod
 *
 * Set NASA_API_KEY env var for higher rate limits (free at https://api.nasa.gov/).
 * Falls back to DEMO_KEY if not configured (30 req/hour, 50 req/day).
 */

import { isRedisConfigured } from "../lib/store.js";
import { Redis } from "@upstash/redis";

const APOD_BASE = "https://api.nasa.gov/planetary/apod";
const CACHE_KEY = "sniffmaster:apod";
const CACHE_TTL_SEC = 86400; // 24 hours — picture changes once a day

// NASA Image and Video Library — no API key required, used as fallback
const NASA_IMAGES_BASE = "https://images-api.nasa.gov/search";
const NASA_IMAGES_QUERIES = ["nebula", "galaxy", "aurora", "solar system", "deep space", "supernova", "milky way", "earth from space"];
const FALLBACK_CACHE_KEY = "sniffmaster:apod-fallback";

async function getCached(key = CACHE_KEY) {
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

async function setCache(data, key = CACHE_KEY) {
  if (!isRedisConfigured()) return;
  try {
    const redis = Redis.fromEnv();
    await redis.set(key, JSON.stringify(data), { ex: CACHE_TTL_SEC });
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // 1. Try the primary APOD cache
  try {
    const cached = await getCached(CACHE_KEY);
    if (cached) {
      return res.status(200).json({ ...cached, source: "cache" });
    }
  } catch {
    // fall through
  }

  // 2. Try live NASA APOD
  try {
    const apod = await fetchApod();
    await setCache(apod, CACHE_KEY);
    return res.status(200).json({ ...apod, source: "live" });
  } catch (apodErr) {
    console.error("apod error:", apodErr);
  }

  // 3. Try the fallback cache (NASA Image Library result from earlier today)
  try {
    const cachedFallback = await getCached(FALLBACK_CACHE_KEY);
    if (cachedFallback) {
      return res.status(200).json({ ...cachedFallback, source: "cache-fallback" });
    }
  } catch {
    // fall through
  }

  // 4. Try live NASA Image Library fallback (no API key required)
  try {
    const fallback = await fetchNasaImageFallback();
    await setCache(fallback, FALLBACK_CACHE_KEY);
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
