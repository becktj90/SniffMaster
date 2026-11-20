/**
 * GET /api/health
 *
 * Lightweight storage health probe for the hosted dashboard.
 * Reports whether Turso is configured and reachable.
 */

import { getStorageHealth, getMonthlyUsage } from "../lib/store.js";

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
  // Free-plan guardrail readout: this month's rows read/written vs Turso's
  // free-tier caps (500M reads / 10M writes), plus whether the 80% read-cap
  // circuit breaker is tripped. getMonthlyUsage never throws (zeros + error
  // field when the store is down), so the health shape stays stable.
  const usage = await getMonthlyUsage();
  const status = health.reachable ? 200 : 503;
  return res.status(status).json({ ...health, usage });
}
