/**
 * GET /api/apod — returns NASA Astronomy Picture of the Day
 *
 * Fetches from the NASA APOD API and caches the result in Upstash Redis
 * for 24 hours (the picture changes once per day).
 * Falls back gracefully on any error.
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

async function getCached() {
  if (!isRedisConfigured()) return null;
  try {
    const redis = Redis.fromEnv();
    const raw = await redis.get(CACHE_KEY);
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

async function setCache(data) {
  if (!isRedisConfigured()) return;
  try {
    const redis = Redis.fromEnv();
    await redis.set(CACHE_KEY, JSON.stringify(data), { ex: CACHE_TTL_SEC });
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const cached = await getCached();
    if (cached) {
      return res.status(200).json({ ...cached, source: "cache" });
    }

    const apod = await fetchApod();
    await setCache(apod);
    return res.status(200).json({ ...apod, source: "live" });
  } catch (err) {
    console.error("apod error:", err);
    return res.status(200).json({
      title: "Astronomy Picture of the Day",
      explanation: "Visit apod.nasa.gov for today's astronomy picture.",
      url: null,
      hdurl: null,
      mediaType: "image",
      date: new Date().toISOString().slice(0, 10),
      apodPageUrl: "https://apod.nasa.gov/apod/",
      source: "error",
      error: err?.message || String(err),
    });
  }
}
