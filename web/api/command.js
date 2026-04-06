/**
 * /api/command
 *
 * GET  — device polls for the newest owner-issued command
 * POST — owner queues a new command from the portal
 *
 * GET auth:    SNIFFMASTER_API_KEY
 * POST auth:   SNIFFMASTER_OWNER_KEY
 */

import { requireDeviceAuth, requireOwnerAuth } from "../lib/auth.js";
import { getLatestCommand, putCommand } from "../lib/store.js";

const COMMAND_TTL_MS = 10 * 60 * 1000;
const ALLOWED_ACTIONS = new Set(["refresh", "ghost_scan", "breath_check", "presence_probe", "play_melody"]);

function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SniffMaster-Key");
  res.setHeader("Cache-Control", "no-store");
}

export default async function handler(req, res) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    if (!requireDeviceAuth(req, res)) return;
    const after = Number(req.query?.after || 0);

    try {
      const latest = await getLatestCommand();
      if (!latest) return res.status(204).end();
      if (Number.isFinite(after) && Number(latest.seq || 0) <= after) {
        return res.status(204).end();
      }
      if (Date.now() - Number(latest.receivedAt || 0) > COMMAND_TTL_MS) {
        return res.status(204).end();
      }
      return res.status(200).json(latest);
    } catch (err) {
      console.error("getLatestCommand error:", err);
      return res.status(500).json({ error: "storage error" });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "GET/POST only" });
  }

  if (!requireOwnerAuth(req, res)) return;

  const action = String(req.body?.action || "").trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: "unsupported action" });
  }

  const melodyKey = String(req.body?.melodyKey || "").trim().toLowerCase();
  if (action === "play_melody") {
    if (!/^[a-z0-9_]{2,64}$/.test(melodyKey)) {
      return res.status(400).json({ error: "valid melodyKey required" });
    }
  }

  try {
    const stored = await putCommand({
      action,
      melodyKey: action === "play_melody" ? melodyKey : undefined,
      source: "portal",
      note: action === "refresh"
        ? "Manual sync requested from portal"
        : action === "ghost_scan"
          ? "Deep-field paranormal diagnostic requested from portal"
        : action === "breath_check"
          ? "Breath analysis requested from portal"
          : action === "play_melody"
            ? `Portal jukebox requested melody ${melodyKey}`
            : "BLE presence probe requested from portal",
    });
    return res.status(200).json({
      ok: true,
      seq: stored.seq,
      action: stored.action,
      melodyKey: stored.melodyKey || null,
      receivedAt: stored.receivedAt,
    });
  } catch (err) {
    console.error("putCommand error:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
