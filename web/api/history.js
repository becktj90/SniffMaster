/**
 * GET /api/history?count=48 — returns recent sensor snapshots (newest first)
 *
 * Query params:
 *   count — number of entries (default 48, max 288)
 */

import { getHistory } from "../lib/store.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const count = Math.min(parseInt(req.query.count) || 48, 288);

  try {
    const data = await getHistory(count);
    return res.status(200).json(data);
  } catch (err) {
    console.error("getHistory error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
