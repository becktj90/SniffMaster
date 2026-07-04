/**
 * GET /api/history?count=48 — returns recent sensor snapshots (newest first)
 *
 * Query params:
 *   count  — number of entries (default 48, max 1008)
 *   fields — "dash" returns only the fields the dashboard actually reads
 *            (charts, rhythm grid, event log, gas baseline). Full snapshots
 *            carry 20-element odor arrays, quips, and other text the history
 *            views never touch; at 1008 entries the projection cuts the
 *            transfer roughly 5x. Omit for the full snapshots (default,
 *            backward compatible).
 */

import { getHistory } from "../lib/store.js";

// Superset of every history field the frontend consumes — keep in sync with
// app.js consumers: normalizeReadingClient (temp/humidity/gas/iaq under every
// naming convention), buildDailyRhythm + drawTrendSeries + drawHeroScope
// (voc/dVoc/airScore/iaq/receivedAt), and buildEventLogEntries
// (airScore/primary/primaryConf).
const DASH_FIELDS = [
  "receivedAt",
  "tempF",
  "tempC",
  "temperature",
  "humidity",
  "pressHpa",
  "pressure",
  "gasR",
  "gas_resistance",
  "gasResistance",
  "iaq",
  "voc",
  "dVoc",
  "co2",
  "airScore",
  "primary",
  "primaryConf",
];

function projectDash(entry) {
  const slim = {};
  for (const key of DASH_FIELDS) {
    if (entry[key] !== undefined) slim[key] = entry[key];
  }
  return slim;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const count = Math.min(parseInt(req.query.count) || 48, 1008);
  const slim = req.query?.fields === "dash";

  try {
    const data = await getHistory(count);
    return res.status(200).json(slim ? data.map(projectDash) : data);
  } catch (err) {
    console.error("getHistory error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
