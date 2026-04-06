/**
 * /api/sniff
 *
 * POST — receives priority sulfur/VSC events from the ESP32
 * GET  — returns the latest priority sulfur/VSC event
 *
 * Expected POST JSON body:
 * {
 *   "key": "<SNIFFMASTER_API_KEY>",
 *   "iaq": 87,
 *   "vsc_conf": 74.5,
 *   "label": "Sulfur"
 * }
 */

import { requireDeviceAuth, sanitizePostedBody } from "../lib/auth.js";
import { getLatestSniff, putSniffEvent } from "../lib/store.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    try {
      const data = await getLatestSniff();
      if (!data) return res.status(204).end();
      return res.status(200).json(data);
    } catch (err) {
      console.error("getLatestSniff error:", err);
      return res.status(500).json({ error: "storage error" });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "GET/POST only" });
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "JSON body required" });
  }

  if (!requireDeviceAuth(req, res)) return;

  const iaq = Number(body.iaq);
  const vscConf = Number(body.vsc_conf);
  const label = String(body.label || "").trim();
  if (!Number.isFinite(iaq) || !Number.isFinite(vscConf) || !label) {
    return res.status(400).json({ error: "iaq, vsc_conf, and label are required" });
  }

  const rest = sanitizePostedBody(body);

  try {
    const stored = await putSniffEvent({
      ...rest,
      iaq: Math.round(iaq),
      vsc_conf: Math.max(0, Math.min(100, vscConf)),
      label: label.slice(0, 48),
    });
    return res.status(200).json({
      ok: true,
      seq: stored.seq,
      receivedAt: stored.receivedAt,
    });
  } catch (err) {
    console.error("putSniffEvent error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
