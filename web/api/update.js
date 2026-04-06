/**
 * POST /api/update — receives sensor snapshots from the ESP32
 *
 * Expected JSON body:
 * {
 *   "key": "<SNIFFMASTER_API_KEY>",
 *   "voc": 0.5, "iaq": 25, "iaqAcc": 3, "co2": 420,
 *   "tempF": 72.5, "humidity": 45.2, "pressHpa": 1013.25,
 *   "gasR": 180000, "dVoc": 0.1, "airScore": 85, "tier": 1,
 *   "cfiScore": 0.92, "cfiPercent": 92, "cfiBand": "Peak",
 *   "vtrLevel": 0, "vtrLabel": "Safe", "vtrAdvice": "...",
 *   "fartCount": 3,
 *   "odors": [0,0,...],        // 20 uint8 scores
 *   "primary": "Clean Air", "primaryConf": 0,
 *   "hazard": "Fresh", "sassy": "...", "quip": "...", "radar": "...",
 *   "uptime": 3600, "outdoorAqi": 42, "city": "Kent"
 * }
 */

import { requireDeviceAuth, sanitizePostedBody } from "../lib/auth.js";
import { putSnapshot } from "../lib/store.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "JSON body required" });
  }

  if (!requireDeviceAuth(req, res)) return;

  const data = sanitizePostedBody(body);

  try {
    const stored = await putSnapshot(data);
    return res.status(200).json({ ok: true, receivedAt: stored.receivedAt });
  } catch (err) {
    console.error("putSnapshot error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
