/**
 * GET /api/health
 *
 * Lightweight storage health probe for the hosted dashboard.
 * Reports whether Upstash Redis is configured and reachable.
 */

import { getStorageHealth } from "../lib/store.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const health = await getStorageHealth();
  const status = health.reachable ? 200 : 503;
  return res.status(status).json(health);
}
