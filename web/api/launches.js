/**
 * GET /api/launches — returns upcoming Cape Canaveral (KSC / CCSFS) launches
 *
 * Fetches from the Launch Library 2 free dev API and caches results in
 * Upstash Redis for one hour to stay well within rate limits.
 * Falls back to an empty list on any error so the dashboard degrades gracefully.
 */

import { isRedisConfigured } from "../lib/store.js";
import { Redis } from "@upstash/redis";

const LL2_BASE = "https://lldev.thespacedevs.com/2.3.0";
const CACHE_KEY = "sniffmaster:launches";
const CACHE_TTL_SEC = 3600; // 1 hour

// KSC location id: 12, CCSFS location id: 27
const CAPE_LOCATION_IDS = "12,27";

async function getCached() {
  if (!isRedisConfigured()) return null;
  try {
    const redis = Redis.fromEnv();
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
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

async function fetchCapeLaunches() {
  const params = new URLSearchParams({
    limit: "5",
    ordering: "net",
    status__ids: "1,2,3,8", // Go, TBC, TBD, In Flight
    location__ids: CAPE_LOCATION_IDS,
  });

  const res = await fetch(`${LL2_BASE}/launch/upcoming/?${params.toString()}`, {
    headers: { "User-Agent": "SniffMaster/1.0 (environmental-dashboard)" },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`launch-library ${res.status}`);
  const json = await res.json();

  return (json?.results || []).map((launch) => ({
    id: launch.id || "",
    name: launch.name || "Unknown mission",
    status: launch.status?.name || "TBD",
    time: launch.net || "TBD",
    provider: launch.launch_service_provider?.name || "Unknown",
    pad: launch.pad?.name || "TBD",
    missionType: launch.mission?.type || "Mission",
  }));
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
      return res.status(200).json({ launches: cached, source: "cache" });
    }

    const launches = await fetchCapeLaunches();
    await setCache(launches);
    return res.status(200).json({ launches, source: "live" });
  } catch (err) {
    console.error("launches error:", err);
    return res.status(200).json({ launches: [], source: "error", error: err?.message || String(err) });
  }
}
