/**
 * GET /api/launches — returns upcoming launches with Cape Canaveral (KSC / CCSFS) launches
 * prioritised, falling back to global upcoming launches when none are scheduled at the Cape.
 *
 * Fetches from the RocketLaunch.Live free API and caches results in
 * Upstash Redis for one hour to stay well within rate limits.
 * Falls back to an empty list on any error so the dashboard degrades gracefully.
 *
 * Data source: https://www.rocketlaunch.live/ (free public API, no key required)
 */

import { isRedisConfigured } from "../lib/store.js";
import { Redis } from "@upstash/redis";

const RLL_BASE = "https://fdo.rocketlaunch.live/json/launches/next/5";
const RLL_ALL_BASE = "https://fdo.rocketlaunch.live/json/launches/next/15";
const CACHE_KEY = "sniffmaster:launches";
const CACHE_TTL_SEC = 3600; // 1 hour

// Cape Canaveral / KSC launch pad location identifiers (rocketlaunch.live uses state abbreviation)
const CAPE_STATE = "FL";
const CAPE_KEYWORDS = ["kennedy", "canaveral", "cape", "ccsfs", "ksc", "slc-40", "slc-41", "lc-39"];

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

function isCapeLocation(launch) {
  const locName = `${launch?.pad?.location?.name || ""} ${launch?.pad?.location?.state || ""} ${launch?.pad?.name || ""}`.toLowerCase();
  const state = `${launch?.pad?.location?.state || ""}`.toUpperCase();
  return state === CAPE_STATE || CAPE_KEYWORDS.some((kw) => locName.includes(kw));
}

function formatLaunchTime(launch) {
  // Prefer t0 (exact), then win_open, then date_str, then est_date
  const t0 = launch.t0;
  if (t0) {
    try {
      return new Date(t0).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      });
    } catch { /* t0 string was not a valid date — fall through to next format */ }
  }
  const winOpen = launch.win_open;
  if (winOpen) {
    try {
      return new Date(winOpen).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      });
    } catch { /* win_open string was not a valid date — fall through to next format */ }
  }
  if (launch.date_str) return launch.date_str;
  const est = launch.est_date;
  if (est) {
    const parts = [];
    if (est.year) parts.push(est.year);
    if (est.quarter) parts.push(`Q${est.quarter}`);
    if (est.month) parts.push(new Date(2000, est.month - 1).toLocaleString("en-US", { month: "short" }));
    if (est.day) parts.push(est.day);
    if (parts.length) return `NET ${parts.join(" ")}`;
  }
  return "TBD";
}

function mapLaunch(launch, isCape) {
  const mission = Array.isArray(launch.missions) && launch.missions.length ? launch.missions[0] : null;
  return {
    id: `${launch.id || ""}`,
    name: launch.name || mission?.name || "Unknown mission",
    status: launch.launch_description || (isCape ? "Cape Canaveral" : "Upcoming"),
    time: formatLaunchTime(launch),
    provider: launch.provider?.name || "Unknown",
    pad: launch.pad?.name || "TBD",
    location: launch.pad?.location?.name || "Unknown",
    missionType: mission?.description ? mission.description.slice(0, 80) : (launch.quicktext || "Mission"),
    isCape: isCape,
    webcastUrl: Array.isArray(launch.links) ? (launch.links.find((l) => /webcast|stream|watch/i.test(l.title))?.url || null) : null,
  };
}

async function fetchLaunches() {
  // Fetch next 15 launches so we can find Cape ones even if they aren't in the first 5
  const res = await fetch(RLL_ALL_BASE, {
    headers: { "User-Agent": "SniffMaster/1.0 (environmental-dashboard)" },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`rocketlaunch.live ${res.status}`);
  const json = await res.json();
  const all = Array.isArray(json?.result) ? json.result : [];

  const capeLaunches = all.filter((l) => isCapeLocation(l)).map((l) => mapLaunch(l, true));
  const globalLaunches = all.filter((l) => !isCapeLocation(l)).map((l) => mapLaunch(l, false));

  if (capeLaunches.length >= 3) {
    return capeLaunches.slice(0, 5);
  }

  // Fill with global launches if not enough Cape ones
  const capeIds = new Set(capeLaunches.map((l) => l.id));
  const filler = globalLaunches.filter((l) => !capeIds.has(l.id));
  return [...capeLaunches, ...filler].slice(0, 5);
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

    const launches = await fetchLaunches();
    await setCache(launches);
    return res.status(200).json({ launches, source: "live" });
  } catch (err) {
    console.error("launches error:", err);
    return res.status(200).json({ launches: [], source: "error", error: err?.message || String(err) });
  }
}
