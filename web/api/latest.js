/**
 * GET /api/latest — returns the most recent sensor snapshot
 *
 * No authentication required (read-only, no PII).
 * Returns 204 if no data has been posted yet.
 */

import { getLatest } from "../lib/store.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  try {
    const data = await getLatest();
    if (!data) return res.status(204).end();
    return res.status(200).json(data);
  } catch (err) {
    console.error("getLatest error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
