/**
 * GET /api/sniff-history?count=12 — returns recent priority sulfur/VSC events
 */

import { getSniffHistory } from "../lib/store.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const count = Math.min(parseInt(req.query.count) || 12, 96);

  try {
    const data = await getSniffHistory(count);
    return res.status(200).json(data);
  } catch (err) {
    console.error("getSniffHistory error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
